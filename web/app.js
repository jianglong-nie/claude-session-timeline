/**
 * app.js — 把 Claude Code 的 stream-json 事件流渲染成页面
 *
 * 数据流：
 *   startRun() / loadArchive() ──POST /api/run──▶ 逐行读 NDJSON 响应 ──▶ dispatch() ──▶ handleEvent(run, ev, m)
 *
 * 三种来源走同一条路：真实运行（claude -p 子进程）、回放录制文件、会话存档（~/.claude/projects 下的 jsonl，
 * 由服务器端 lib/session-adapter.js 转成同样的事件格式；多出一种 user_prompt 事件表示人类说的话）。
 * 第四种是静态模式：scripts/export.mjs 把转换好的事件数组内联成 window.CLAUDE_TIMELINE 写进单文件 HTML，
 * 页面发现它就直接渲染，不碰服务器，顶栏和输入区里需要服务器的控件全部隐藏。
 *
 * 原则：
 *   1. 文件里的每一行都在页面上有一个节点，一个都不丢；左侧序号 #N 就是它在这次运行里的行号，点序号看原始 JSON。
 *   2. 所有节点在一条时间线上，按到达顺序追加，永不移动。
 *   3. 每个节点属于一条"线"：主线（lane 0）或某个子智能体的支线（lane 1、2…）。
 *      归线规则：parent_tool_use_id（或 system 事件的 tool_use_id）指向哪个 Agent 调用，就进那个 Agent 的支线；都没有就在主线。
 *      每行左侧的轨道列画出当时活着的线：主线灰色竖线，支线彩色竖线；Agent 行是分出点，"◄ 收到完成通知"行（前台：收到返回）是并回点。
 *   5. 文字视角：主线上的每一行都说"主智能体收到了什么 / 做了什么"，时间戳就是收到或做的那一刻；
 *      支线上的行站在子智能体视角。"结束"指子智能体进程停了（取通知入队时刻），"收到"指主智能体从队列取走。
 *   4. 只有一种合并：同一条线上连续的 thinking_tokens 进度事件和随后的 thinking 块合成一行，序号显示范围。
 *
 * m 是每个事件的元信息：{ seq, rel: 到达时距运行开始的毫秒数, ts: 事件自带时间戳, ev: 原始事件 }
 */
'use strict';

// ============================================================ 状态
const state = {
  runs: [],
  sessionId: null,   // 当前对话的 session_id；下一次运行用 --resume 恢复
  turn: 0,
  current: null,
  showAll: localStorage.getItem('showAll') !== '0',
};

/** 每条子智能体支线一个颜色（轨道、Agent 标签、大纲共用），按子智能体出现顺序轮流取 */
const LANE_COLORS = ['#0B5ED7', '#B26B00', '#1E7E38', '#7B3FA0', '#A8322E', '#0A7C86'];
const MAIN_COLOR = '#9AA3AE';
const LANE_W = 19;          // 轨道列里每条线的间距（与 CSS 的 .rails 同步）
const RAIL_X0 = 7;          // 主线的横坐标

const $ = (s) => document.querySelector(s);
const els = {
  app: $('.app'), cwd: $('#cwd'), prompt: $('#prompt'), run: $('#run'), stop: $('#stop'), replay: $('#replay'),
  newSession: $('#new-session'), sessionInfo: $('#session-info'), showAll: $('#show-all'),
  conversation: $('#conversation'), outline: $('#outline'), outlineBody: $('#outline-body'),
  toggleOutline: $('#toggle-outline'), empty: $('#empty'), reloadPage: $('#reload-page'),
  project: $('#project'), session: $('#session'), loadSession: $('#load-session'), follow: $('#follow'),
  refreshSessions: $('#refresh-sessions'), sessionHint: $('#session-hint'),
};
let projects = [];   // /api/sessions 的结果

// ============================================================ 初始化
// init() 的调用在文件末尾：静态模式会同步跑到 dispatch，必须等整个文件执行完（let 声明都已初始化）
async function init() {
  if (window.marked) marked.use({ gfm: true, breaks: true });
  els.toggleOutline.addEventListener('click', () => els.outline.classList.toggle('open'));
  if (els.reloadPage) els.reloadPage.addEventListener('click', () => location.reload());
  els.showAll.checked = state.showAll;
  els.showAll.addEventListener('change', () => { state.showAll = els.showAll.checked; applyShowAll(); });
  applyShowAll();
  if (window.CLAUDE_TIMELINE) return loadStatic(window.CLAUDE_TIMELINE);   // 导出的单文件：事件已经在页面里
  const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
  els.cwd.value = localStorage.getItem('cwd') || cfg.default_cwd || '';
  for (const name of cfg.recordings || []) {
    const o = document.createElement('option');
    o.value = name; o.textContent = `回放文件 ${name}`;
    els.replay.appendChild(o);
  }
  els.run.addEventListener('click', startRun);
  els.stop.addEventListener('click', stopRun);
  els.prompt.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); startRun(); }
  });
  els.cwd.addEventListener('change', () => {
    localStorage.setItem('cwd', els.cwd.value.trim());
    // Claude Code 按工作目录存会话，换了目录就不能再 --resume 了，所以自动开新会话
    if (state.sessionId) { resetSession(); notice('工作目录已更改，已开始新会话'); }
  });
  els.newSession.addEventListener('click', () => { resetSession(); notice('已开始新会话'); });
  updateSessionInfo();
  els.project.addEventListener('change', fillSessions);
  els.session.addEventListener('change', showSessionHint);
  els.loadSession.addEventListener('click', () => loadArchive(els.follow.checked));
  els.refreshSessions.addEventListener('click', refreshSessions);
  refreshSessions();
}

// ============================================================ 0a. 静态模式（导出的单文件）
/**
 * data = { session: { id, title, cwd, project, ... }, events: [...], exported_at, source_file, lines }
 * 事件数组和服务器 /api/run 送来的一模一样，所以直接逐条 dispatch；没有子进程，也不需要停止按钮。
 */
function loadStatic(data) {
  els.app.classList.add('static');
  const s = data.session || {};
  const note = $('#static-note');
  if (note) {
    const when = data.exported_at ? new Date(data.exported_at).toLocaleString('zh-CN', { hour12: false }) : '';
    note.textContent = `导出于 ${when}${data.lines ? ` · 存档 ${data.lines} 行` : ''} · 之后的内容不含`;
    note.title = data.source_file || '';
    note.hidden = false;
  }
  const run = createRun({
    prompt: s.title || s.first_prompt || `会话 ${shortId(s.id)}`,
    cwd: s.cwd || '', replay: null, resumedSession: null,
    archive: { project: s.project || null, id: s.id || null, cwd: s.cwd || null, follow: false },
  });
  state.current = run;
  dispatch(run, JSON.stringify({ type: 'run_started', run_id: 'static', mode: 'archive', archive: run.archive, started_at: Date.now() }));
  for (const ev of data.events || []) dispatch(run, typeof ev === 'string' ? ev : JSON.stringify(ev));
  dispatch(run, JSON.stringify({ type: 'run_exit', code: 0, archive: true, lines: data.lines || null }));
  finishRun(run);
  state.current = null;
  els.conversation.scrollTop = 0;
  run.el.scrollIntoView({ block: 'start' });
}

// ============================================================ 0b. 会话存档选择器
async function refreshSessions() {
  els.project.innerHTML = '<option value="">加载中…</option>';
  try {
    const data = await fetch('/api/sessions').then((r) => r.json());
    projects = data.projects || [];
  } catch { projects = []; }
  els.project.innerHTML = '';
  if (!projects.length) { els.project.innerHTML = '<option value="">（没有找到会话存档）</option>'; els.session.innerHTML = ''; return; }
  for (const p of projects) {
    const o = document.createElement('option');
    o.value = p.dir;
    o.textContent = `${p.cwd || p.dir}（${p.sessions.length} 个会话）`;
    els.project.appendChild(o);
  }
  // 默认选中最近有活动的项目；记住上次的选择
  const remembered = localStorage.getItem('archiveProject');
  els.project.value = projects.some((p) => p.dir === remembered) ? remembered : projects[0].dir;
  fillSessions();
  // 地址栏带 ?project=…&session=…[&follow=1] 时直接载入（可以把某个会话的链接发给别人，或用来截图）
  const q = new URLSearchParams(location.search);
  if (q.get('session') && !refreshSessions.autoLoaded) {
    refreshSessions.autoLoaded = true;
    // session 允许只给前缀（/timeline 68be），按前缀找；多个匹配取最近写入的（列表已按时间排序）
    const want = q.get('session').toLowerCase();
    const hit = (x) => x.sessions.find((s) => s.id.toLowerCase() === want) || x.sessions.find((s) => s.id.toLowerCase().startsWith(want));
    const p = projects.find((x) => x.dir === q.get('project') && hit(x)) || projects.find((x) => hit(x));
    if (p) { els.project.value = p.dir; fillSessions(); els.session.value = hit(p).id; showSessionHint(); loadArchive(q.get('follow') === '1'); }
    else notice(`没有找到会话 ${q.get('session')}`);
  }
}
function fillSessions() {
  const p = projects.find((x) => x.dir === els.project.value);
  localStorage.setItem('archiveProject', els.project.value);
  els.session.innerHTML = '';
  if (!p) return;
  for (const sess of p.sessions) {
    const o = document.createElement('option');
    o.value = sess.id;
    const when = sess.started_at ? new Date(sess.started_at).toLocaleString('zh-CN', { hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '';
    const label = (sess.title || sess.first_prompt || '（无提示词）').replace(/\s+/g, ' ').slice(0, 48);
    o.textContent = `${when}  ${label}  · ${sess.prompts} 轮 · ${sess.tool_uses} 次调用${sess.subagents ? ` · ${sess.subagents} 个子智能体` : ''}${typeof sess.cost_usd === 'number' ? ' · ' + fmtCost(sess.cost_usd) : ''}`;
    els.session.appendChild(o);
  }
  showSessionHint();
}
function currentSession() {
  const p = projects.find((x) => x.dir === els.project.value);
  return p ? { project: p, session: p.sessions.find((s) => s.id === els.session.value) || null } : { project: null, session: null };
}
function showSessionHint() {
  const { session } = currentSession();
  els.sessionHint.textContent = session ? `${session.id} · ${session.lines} 行 · ${session.entrypoint || ''} ${session.version || ''} · ${session.model || ''}` : '';
}

/** 载入一个会话存档（follow 为真时持续跟随文件末尾） */
async function loadArchive(follow) {
  if (state.current) return;
  const { project, session } = currentSession();
  if (!project || !session) return;
  const run = createRun({
    prompt: session.title || session.first_prompt || `会话 ${shortId(session.id)}`,
    cwd: session.cwd || '', replay: null, resumedSession: null,
    archive: { project: project.dir, id: session.id, cwd: session.cwd, follow },
  });
  await streamRun(run, { archive: { project: project.dir, id: session.id }, follow: !!follow });
}

function applyShowAll() {
  els.app.classList.toggle('show-all', state.showAll);
  localStorage.setItem('showAll', state.showAll ? '1' : '0');
}

function resetSession() { state.sessionId = null; state.turn = 0; updateSessionInfo(); }

function updateSessionInfo() {
  els.sessionInfo.innerHTML = state.sessionId
    ? `会话 <span class="sid">${esc(shortId(state.sessionId))}</span> · 已 ${state.turn} 轮 · 下一条提示将恢复此会话`
    : '新会话（第一条提示词会创建会话）';
}
let noticeTimer;
function notice(msg) {
  els.sessionInfo.textContent = msg;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(updateSessionInfo, 2500);
}

// ============================================================ 1. 发起一次运行，逐行读事件
async function startRun() {
  if (state.current) return;
  const prompt = els.prompt.value.trim();
  const replay = els.replay.value;
  const cwd = els.cwd.value.trim();
  if (!prompt && !replay) { els.prompt.focus(); return; }

  const run = createRun({
    prompt: prompt || `（回放文件 ${replay}）`,
    cwd, replay,
    resumedSession: replay ? null : state.sessionId,   // 回放不参与真实会话
  });
  els.prompt.value = '';
  await streamRun(run, { prompt, cwd, session_id: run.resumedSession, replay: replay || undefined });
}

/** 三种来源共用：POST /api/run，边到边解析 NDJSON，喂给 dispatch */
async function streamRun(run, body) {
  state.current = run;
  for (const r of state.runs) if (r !== run) collapseRun(r, true);
  setBusy(true);
  try {
    const resp = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok || !resp.body) throw new Error(`服务器返回 ${resp.status}`);
    // 关键：不等响应结束，边到边解析。响应体是 NDJSON，一行一个事件。
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) dispatch(run, line);
      }
    }
    if (buf.trim()) dispatch(run, buf.trim());
  } catch (e) {
    run.error = run.error || `连接服务器失败：${e.message}`;
  } finally {
    finishRun(run);
    state.current = null;
    setBusy(false);
    els.prompt.focus();
  }
}

function dispatch(run, line) {
  let ev;
  try { ev = JSON.parse(line); } catch { ev = { type: 'raw_stdout', line }; }
  run.eventCount++;
  const m = { seq: run.eventCount, rel: Date.now() - run.startedAt, ts: ev.timestamp || null, ev };
  const stick = nearBottom();
  handleEvent(run, ev, m);
  if (stick) els.conversation.scrollTop = els.conversation.scrollHeight;
  scheduleOutline();
}

async function stopRun() {
  const run = state.current;
  if (!run || !run.serverId) return;
  await fetch(`/api/stop/${run.serverId}`, { method: 'POST' }).catch(() => {});
}

function setBusy(busy) {
  els.run.disabled = busy;
  els.stop.hidden = !busy;
  els.replay.disabled = busy;
  els.loadSession.disabled = busy;
}

// ============================================================ 2. 事件 → 节点
function handleEvent(run, ev, m) {
  switch (ev.type) {
    // --- 服务器自造的三种事件 ---
    case 'run_started':
      run.serverId = ev.run_id;
      addAux(run, run.root, m, 'server', `运行已创建 · ${{ replay: '回放文件', live: '真实运行', archive: '载入会话存档', 'archive-follow': '跟随会话存档' }[ev.mode] || ev.mode}${ev.resumed_session_id ? ' · --resume ' + shortId(ev.resumed_session_id) : ''}`);
      break;
    case 'run_error':
      run.error = ev.message;
      addAux(run, run.root, m, 'server', `启动失败 · ${ev.message}`, 'error');
      break;
    case 'run_exit':
      Object.assign(run, { exitCode: ev.code, exitSignal: ev.signal, stopped: !!ev.stopped, stderr: ev.stderr || '' });
      addAux(run, run.root, m, 'server', ev.archive
        ? `存档读取结束${ev.follow ? ' · 跟随已停止' : ''}${ev.lines ? ` · 文件共 ${ev.lines} 行` : ''}`
        : `子进程退出 · 退出码 ${ev.code}${ev.signal ? ' · 信号 ' + ev.signal : ''}${ev.stopped ? ' · 用户停止' : ''}`, ev.code ? 'error' : '');
      break;
    // --- Claude Code 的事件 ---
    case 'system':    onSystem(run, ev, m); break;
    case 'assistant': onAssistant(run, ev, m); break;
    case 'user':      onUser(run, ev, m); break;
    case 'result':    onResult(run, ev, m); break;
    case 'user_prompt':   // 会话存档里人类说的话：新一轮开始，上一轮的最终回答保持展开
      if (m.ts) run.root.lastUserTs = m.ts;
      run.root.latestText = null;
      addNode(run, run.root, makePromptNode(ev, m));
      break;
    case 'raw_stdout': addNode(run, run.root, makeTextNode('```\n' + ev.line + '\n```', m)); break;
    default: addAux(run, containerFor(run, ev), m, ev.type, '未知事件类型');
  }
}

/** 这个事件属于哪条线：有 parent_tool_use_id（或 system 事件的 tool_use_id）就是那个 Agent 的支线，否则主线 */
function containerFor(run, ev) {
  const pid = ev.parent_tool_use_id || (ev.type === 'system' ? ev.tool_use_id : null);
  if (pid && run.tools.has(pid)) return ensureSubagent(run, run.tools.get(pid));
  return run.root;
}

function onAssistant(run, ev, m) {
  const content = ev.message && ev.message.content;
  if (!Array.isArray(content)) return addAux(run, containerFor(run, ev), m, 'assistant', '（content 不是数组）');
  const parent = containerFor(run, ev);
  // 同一条 message 会拆成多行（thinking / text / tool_use 各一行）。新 message 开始时，请求起点 = 这条线上最后一条 user 事件的时间
  const msgId = ev.message.id || null;
  if (msgId !== parent.msgId) { parent.msgId = msgId; parent.msgStart = parent.lastUserTs; parent.msgThinkMs = 0; }
  parent.msgThinkMs += parent.pendingThinkMs; parent.pendingThinkMs = 0;
  for (const b of content) {
    if (b.type === 'text') {
      if (b.text && b.text.trim()) {
        if (parent !== run.root) { addNode(run, parent, makeLaneTextNode(b.text, m)); continue; }   // 子智能体支线：不加框，折叠成 1 行
        const node = makeTextNode(b.text, m);
        // 回复用时：这段文本写完的时刻 − 请求开始。文本总在工具调用之前流出，不会被工具执行拖后（见 README）
        const total = m.ts && parent.msgStart ? Date.parse(m.ts) - Date.parse(parent.msgStart) : NaN;
        if (Number.isFinite(total) && total >= 0) setReplyTime(node, total, parent.msgThinkMs);
        addNode(run, parent, node);
        trackLatestText(parent, node);
      } else addAux(run, parent, m, 'assistant/text', '（空文本）');
    } else if (b.type === 'tool_use') {
      const node = makeToolNode(run, b, m);
      run.tools.set(b.id, node);                 // 之后 tool_result 靠这个 id 找回来
      addNode(run, parent, node);
    } else if (b.type === 'thinking') {
      const p = parent.pendingThinking;
      const text = b.thinking && b.thinking.trim();
      let info;
      if (p && parent.children[parent.children.length - 1] === p.node) {
        // 紧跟在同一条线上的思考进度之后：并入那一行
        p.node.addEvent(m); info = p; parent.pendingThinking = null;
      } else {
        const node = makeThinkingNode(m);
        addNode(run, parent, node);
        info = { node, tokens: parent.lastThinkingTokens, durationMs: parent.lastThinkingDuration };
      }
      parent.lastThinkingTokens = null; parent.lastThinkingDuration = null;   // 用过一次就清掉，同一条消息的第二个 thinking 块不再重复显示
      setThinkingText(info, false);
      if (text) {
        // 会话存档里有时保留了思考正文（stream-json 里只有签名）
        const summary = info.node.body.innerHTML;
        info.node.body.innerHTML = `<details><summary>${summary} · 正文 ${text.length} 字</summary><div class="md"></div></details>`;
        info.node.body.querySelector('.md').innerHTML = md(text);
      }
    } else {
      addAux(run, parent, m, `assistant/${b.type}`, JSON.stringify(b).slice(0, 120));
    }
  }
}

function onUser(run, ev, m) {
  const content = ev.message && ev.message.content;
  const parent = containerFor(run, ev);
  if (m.ts) parent.lastUserTs = m.ts;   // 下一条模型回复的请求从这里开始算
  if (typeof content === 'string') {
    addNode(run, parent, makeSubpromptNode(content, m, parent === run.root ? '用户消息' : '子智能体收到的任务'));
    return;
  }
  for (const b of content || []) {
    if (b.type === 'tool_result') {
      const tool = run.tools.get(b.tool_use_id);
      if (tool) setToolResult(run, parent, tool, b, m);
      else addAux(run, parent, m, 'user/tool_result', `找不到对应的工具调用 ${b.tool_use_id}`, 'error');
    } else if (b.type === 'text') {
      addNode(run, parent, makeSubpromptNode(b.text, m, parent === run.root ? '用户消息' : '子智能体收到的任务'));
    } else {
      addAux(run, parent, m, `user/${b.type}`, JSON.stringify(b).slice(0, 120));
    }
  }
}

function onSystem(run, ev, m) {
  const sub = ev.subtype;
  switch (sub) {
    case 'init': {
      const first = !run.sessionId;
      if (first) {
        run.sessionId = ev.session_id;
        run.model = ev.model;
        // 一拿到 session_id 就记下来：即使中途被停止，这个会话也是可以恢复的
        if (!run.replay && !run.archive) { state.sessionId = ev.session_id; updateSessionInfo(); }
        updateMeta(run);
      }
      addNode(run, run.root, makeInitNode(ev, m, first));
      break;
    }
    case 'thinking_tokens': {
      // Claude 每思考约 50 个 token 就发一条进度事件；同一条线上连续的进度事件合并成一行原地更新
      const c = containerFor(run, ev);
      c.lastThinkingTokens = ev.estimated_tokens;
      c.lastThinkingDuration = ev.duration_ms || null;
      c.pendingThinkMs += ev.duration_ms || 0;
      run.thinkingTokens += ev.estimated_tokens_delta || 0;
      const p = c.pendingThinking;
      if (p && c.children[c.children.length - 1] === p.node) { p.tokens = ev.estimated_tokens; p.durationMs = ev.duration_ms || p.durationMs; p.node.addEvent(m); }
      else {
        const node = makeThinkingNode(m);
        addNode(run, c, node);
        c.pendingThinking = { node, tokens: ev.estimated_tokens, durationMs: ev.duration_ms || null };
      }
      setThinkingText(c.pendingThinking, true);
      updateMeta(run);
      break;
    }
    case 'task_started': {
      const t = run.tools.get(ev.tool_use_id);
      const c = t ? ensureSubagent(run, t) : run.root;
      addNode(run, c, makeTaskNode(ev, m));
      if (t) setProgress(t, '子智能体运行中');
      break;
    }
    case 'task_progress': {
      const t = run.tools.get(ev.tool_use_id);
      const u = ev.usage || {};
      // 三个数都是从子智能体启动算起的累计值；每调一次工具发一条
      const text = ['进度', u.total_tokens != null && `total_tokens ${fmtTokens(u.total_tokens)}`, u.duration_ms != null && `已运行 ${fmtDur(u.duration_ms)}`, `${u.tool_uses || 0} 次调用`].filter(Boolean).join(' · ');
      if (t) setProgress(t, text.replace('进度 · ', ''));
      addAux(run, t ? ensureSubagent(run, t) : run.root, m, 'system/task_progress', text);
      break;
    }
    case 'task_notification': {
      // 子智能体回到主线的时刻：并回节点放在启动它的那条线上（通常是主线）
      const t = run.tools.get(ev.tool_use_id);
      if (!t) { addAux(run, run.root, m, 'system/task_notification', `找不到对应的 Agent 调用 ${ev.tool_use_id}`, 'error'); break; }
      const parent = t.parent || run.root;
      const node = makeMergeNode(run, ev, m, t);
      addNode(run, parent, node);
      if (m.ts) parent.lastUserTs = m.ts;   // 唤醒主智能体的那条消息就是下一次请求的起点
      t.mergeSeq = m.seq; t.mergeEl = node.el; t.mergeStatus = ev.status === 'completed' ? 'ok' : 'error';
      if (t.status !== 'error') setToolStatus(t, ev.status === 'completed' ? 'ok' : 'error');
      setProgress(t, ev.status === 'completed' ? '已收到完成通知' : `收到通知：${ev.status}`);
      break;
    }
    case 'task_updated':
      addAux(run, run.root, m, 'system/task_updated', `任务 ${shortId(ev.task_id)} · ${JSON.stringify(ev.patch || {})}`);
      break;
    case 'background_tasks_changed': {
      const tasks = ev.tasks || [];
      addAux(run, run.root, m, 'system/background_tasks_changed', `后台任务 ${tasks.length} 个${tasks.length ? '：' + tasks.map((t) => t.description || t.task_id).join('；') : ''}`);
      break;
    }
    default: {
      // 会话存档转换出来的系统行（turn_duration、local_command、api_error、attachment/*、user_interrupt…）都带 text
      const c = containerFor(run, ev);
      if (ev.from_user_row && m.ts) c.lastUserTs = m.ts;   // 原本是一条 user 行（外壳注入的消息），下一条回复的请求从它开始
      addAux(run, c, m, `system/${sub}`, ev.text != null ? ev.text : JSON.stringify(ev).slice(0, 120), ev.level === 'error' ? 'error' : '', ev.detail || null);
    }
  }
}

function onResult(run, ev, m) {
  run.results.push(ev);
  if (ev.session_id) { run.sessionId = ev.session_id; if (!run.replay && !run.archive) state.sessionId = ev.session_id; }
  // 时间线原则：什么都不搬。result 事件就是主线上的一个节点，排在它到达的位置。
  addNode(run, run.root, makeResultNode(ev, m));
  if (ev.is_error) run.error = run.error || ((typeof ev.result === 'string' && ev.result.trim()) || `结果事件报告错误（${ev.subtype}）`);
  updateMeta(run);
}

// ============================================================ 3. 运行、线、节点

function createRun({ prompt, cwd, replay, resumedSession, archive = null }) {
  els.empty.hidden = true;
  const el = h('article', 'run');
  el.dataset.status = 'running';
  el.style.setProperty('--lanes', 1);
  el.innerHTML = `
    <header class="run-head">
      <span class="pill pill-you"></span>
      <div class="run-prompt"></div>
      <span class="status running"><span class="dot"></span><span class="status-text">运行中</span></span>
    </header>
    <div class="run-sub" hidden></div>
    <button class="run-collapse" hidden></button>
    <div class="run-body"></div>
    <div class="run-final" hidden></div>
    <div class="run-error" hidden></div>
    <div class="run-meta" hidden></div>`;
  el.querySelector('.run-prompt').textContent = prompt;
  el.querySelector('.run-head .pill').textContent = archive ? 'Session' : 'User';
  const run = {
    id: state.runs.length + 1, prompt, cwd, replay, resumedSession, archive,
    sessionId: null, model: null, status: 'running', startedAt: Date.now(), endedAt: null,
    results: [], tools: new Map(), eventCount: 0, thinkingTokens: 0, error: null, exitCode: null, serverId: null,
    nodes: [],             // 时间线上的全部节点，按到达顺序
    lanes: [],             // 支线列表：第 i 项是占着第 i+1 列的 Agent 工具节点，并回后该列可复用
    agentCount: 0,         // 本次运行已出现的子智能体数，用来轮流取颜色
    active: new Map(),     // 此刻活着的支线：lane -> { color, fg }
    hiddenLanes: new Set(),
    maxLane: 0,
    el,
    elStatus: el.querySelector('.status'), elStatusText: el.querySelector('.status-text'),
    elSub: el.querySelector('.run-sub'), elCollapse: el.querySelector('.run-collapse'),
    elBody: el.querySelector('.run-body'), elFinal: el.querySelector('.run-final'),
    elError: el.querySelector('.run-error'), elMeta: el.querySelector('.run-meta'),
  };
  run.root = { kind: 'root', lane: 0, children: [], pendingThinking: null, lastThinkingTokens: null, lastUserTs: null, msgId: null, msgStart: null, msgThinkMs: 0, pendingThinkMs: 0, latestText: null };
  if (resumedSession) {
    run.elSub.innerHTML = `已恢复会话 <span class="sid">${esc(shortId(resumedSession))}</span>`;
    run.elSub.hidden = false;
  } else if (replay) {
    run.elSub.textContent = `回放文件 ${replay}（不计入真实会话）`;
    run.elSub.hidden = false;
  } else if (archive) {
    run.elSub.innerHTML = `会话存档 <span class="sid">${esc(archive.id)}</span>${archive.cwd ? ' · ' + esc(archive.cwd) : ''}${archive.follow ? ' · 实时跟随中，点"停止"结束' : ''}`;
    run.elSub.hidden = false;
  }
  run.elCollapse.addEventListener('click', () => collapseRun(run, !run.el.classList.contains('collapsed')));
  run.timer = setInterval(() => { if (run.status === 'running') run.elStatusText.textContent = `运行中 · ${fmtDur(Date.now() - run.startedAt)}`; }, 1000);
  state.runs.push(run);
  els.conversation.appendChild(el);
  el.scrollIntoView({ block: 'start' });
  return run;
}

function collapseRun(run, collapsed) {
  if (collapsed) buildCollapsedSummary(run);
  run.el.classList.toggle('collapsed', collapsed);
  run.elCollapse.hidden = false;
  run.elCollapse.textContent = collapsed ? `▸ ${run.eventCount} 个事件，已折叠` : `▾ ${run.eventCount} 个事件，收起`;
}

/** 折叠态的摘要：最后一轮回答的副本。只在折叠时显示，原文仍在时间线原位。 */
function buildCollapsedSummary(run) {
  run.elFinal.innerHTML = '';
  let last = null;
  for (let i = run.nodes.length - 1; i >= 0; i--) if (run.nodes[i].kind === 'text' && run.nodes[i].lane === 0) { last = run.nodes[i]; break; }
  if (!last) { run.elFinal.hidden = true; return; }
  const note = h('div', 'final-note');
  note.textContent = `最后一轮回答（副本，原文在 #${last.seq}）`;
  const copy = h('div', 'md');
  copy.innerHTML = (last.el.querySelector('.asst-body') || last.el.querySelector(':scope > .node-body')).innerHTML;
  run.elFinal.append(note, copy);
  run.elFinal.hidden = false;
}

/**
 * 把节点加进时间线。parent 只是逻辑归属（主线 root 或某个 Agent 工具节点），决定节点在哪条线上；
 * DOM 上所有节点都追加到 run.elBody 末尾，按到达顺序。
 */
function addNode(run, parent, node) {
  const p = parent.pendingThinking;
  if (p && node !== p.node) { setThinkingText(p, false); parent.pendingThinking = null; }
  node.parent = parent;
  node.lane = parent.kind === 'root' ? 0 : parent.subLane;
  parent.children.push(node);
  run.nodes.push(node);
  node.el.dataset.lane = node.lane;
  node.el.style.setProperty('--lane', node.lane);
  renderRails(run, node);
  // 分出 / 并回：画完本行再更新"活着的支线"集合
  if (node.branchTo != null) { run.active.set(node.branchTo, { color: node.laneColor, fg: node.input.run_in_background !== true }); }
  if (node.mergeFrom != null) run.active.delete(node.mergeFrom);
  if (parent.kind === 'tool' && parent.laneHidden) node.el.classList.add('lane-hidden');
  run.elBody.appendChild(node.el);
  if (parent.kind === 'tool') updateSubagentLabel(parent);
}

/** 画本行的轨道：主线、活着的支线、分出/并回的横线、本行所在线上的点 */
function renderRails(run, node) {
  const rails = node.el.querySelector(':scope > .rails');
  rails.innerHTML = '';
  const x = (c) => RAIL_X0 + c * LANE_W;
  const waitingBefore = [...run.active.values()].some((a) => a.fg);
  const waitingAfter = node.mergeFrom != null
    ? [...run.active].some(([l, a]) => a.fg && l !== node.mergeFrom)
    : waitingBefore || (node.branchTo != null && node.input.run_in_background !== true);
  const add = (cls, lane, color, left, extra = '') => {
    const i = h('i', cls); i.dataset.lane = lane; i.style.left = left + 'px'; i.style.setProperty('--c', color);
    if (extra) i.style.cssText += extra;
    if (run.hiddenLanes.has(lane)) i.classList.add('hidden');
    rails.appendChild(i);
  };
  // 主线：永远画；前台子智能体运行期间是虚线（主智能体在等）。等待状态在本行变化时，上下两半分开画
  if (waitingBefore === waitingAfter) add(`rail${waitingBefore ? ' dashed' : ''}`, 0, MAIN_COLOR, x(0));
  else {
    add(`rail top${waitingBefore ? ' dashed' : ''}`, 0, MAIN_COLOR, x(0));
    add(`rail bottom${waitingAfter ? ' dashed' : ''}`, 0, MAIN_COLOR, x(0));
  }
  // 活着的支线：并回的那条只画到点为止
  for (const [lane, a] of run.active) add(`rail${lane === node.mergeFrom ? ' top' : ''}`, lane, a.color, x(lane));
  // 分出：从本行的点横到新支线，再向下
  if (node.branchTo != null) {
    add('rail-h', node.branchTo, node.laneColor, Math.min(x(node.lane), x(node.branchTo)), `width:${Math.abs(x(node.branchTo) - x(node.lane))}px`);
    add('rail bottom', node.branchTo, node.laneColor, x(node.branchTo));
  }
  // 并回：支线在点的高度横回本行
  if (node.mergeFrom != null) {
    const color = run.active.get(node.mergeFrom)?.color || node.laneColor || MAIN_COLOR;
    add('rail-h', node.mergeFrom, color, Math.min(x(node.lane), x(node.mergeFrom)), `width:${Math.abs(x(node.mergeFrom) - x(node.lane))}px`);
  }
  // 本行的点
  const own = node.lane === 0 ? MAIN_COLOR : (run.active.get(node.lane)?.color || node.laneColor || MAIN_COLOR);
  add('rail-dot', node.lane, node.branchTo != null ? node.laneColor : own, x(node.lane));
  const cols = Math.max(node.lane, node.branchTo || 0, ...run.active.keys()) + 1;
  if (cols > run.maxLane) { run.maxLane = cols; run.el.style.setProperty('--lanes', cols); }
}

/** 辅助事件：一行灰色小字，带类型标签。开关关掉时整体隐藏。 */
function addAux(run, parent, m, type, text, cls = '', detail = null) {
  const { el, body } = wrapNode('aux', m, { aux: true });
  if (cls) el.classList.add(cls);
  body.innerHTML = `<span class="aux-type"></span><span class="aux-text"></span>`;
  body.querySelector('.aux-type').textContent = type;
  body.querySelector('.aux-text').textContent = text;
  if (detail) { el.classList.add('has-detail'); body.appendChild(collapsibleText(detail, { headLines: 0, maxChars: 0 })); }
  addNode(run, parent, { kind: 'aux', el, seq: m.seq });
}

/**
 * 所有节点的公共外壳：序号槽 | 轨道列 | 内容；原始 JSON 在内容下方。
 * 返回 { el, body, addEvent }，调用方往 body 里填内容；addEvent 用于一个节点对应多条事件（思考合并）。
 */
function wrapNode(kind, m, { aux = false } = {}) {
  const el = h('div', `node node-${kind}${aux ? ' aux' : ''}`);
  const gutter = h('button', 'gutter');
  const rails = h('div', 'rails');
  const body = h('div', 'node-body');
  const raw = h('pre', 'raw');
  raw.hidden = true;
  const events = m ? [m] : [];
  const header = (x) => `// 第 ${x.seq} 个事件 · 到达 +${(x.rel / 1000).toFixed(1)} 秒 · ${x.ts ? '事件时间戳 ' + x.ts : '此事件没有 timestamp 字段'}`;
  const refresh = () => {
    if (!events.length) return;
    const a = events[0], b = events[events.length - 1];
    gutter.textContent = events.length === 1 ? `#${a.seq}` : `#${a.seq}–${b.seq}`;
    gutter.title = (events.length === 1 ? `第 ${a.seq} 个事件` : `第 ${a.seq} 到 ${b.seq} 个事件（${events.length} 条，合并显示）`) +
      ` · 到达于 +${(a.rel / 1000).toFixed(1)} 秒${a.ts ? ' · 事件时间 ' + fmtClock(a.ts) : ''}\n点击查看原始 JSON`;
    raw.textContent = '';
    if (!raw.hidden) raw.textContent = events.map((x) => header(x) + '\n' + JSON.stringify(x.ev, null, 2)).join('\n\n');
  };
  gutter.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!events.length) return;
    raw.hidden = !raw.hidden;
    if (!raw.hidden && !raw.textContent) raw.textContent = events.map((x) => header(x) + '\n' + JSON.stringify(x.ev, null, 2)).join('\n\n');
    el.classList.toggle('raw-open', !raw.hidden);
  });
  refresh();
  el.append(gutter, rails, body, raw);
  return { el, body, addEvent: (x) => { events.push(x); refresh(); } };
}

/** 子智能体支线上的文本：不加框，先只露 1 行，点开看全文（Markdown） */
function makeLaneTextNode(text, m) {
  const { el, body } = wrapNode('text', m);
  body.appendChild(collapsibleText(text, { markdown: true }));
  return { kind: 'text', text, el, body, seq: m.seq };
}

/**
 * 主线助手文本：一个框，和 User 框对称。框头是 Assistant 标签 + 用时，正文 Markdown。
 * 两种显示状态：full 全文 / peek 只露前 3 行。最新一段全文，之前的收成 3 行，所以每轮最终回答总是展开的。
 */
function makeTextNode(text, m) {
  const { el, body } = wrapNode('text', m);
  el.classList.add('asst');
  body.innerHTML = `<div class="asst-head"><span class="pill pill-answer">Assistant</span><span class="reply-time"></span><button class="asst-toggle" hidden></button></div><div class="asst-body md"></div>`;
  body.querySelector('.asst-body').innerHTML = md(text);
  const lines = text.split('\n').length;
  const long = lines > 3 || text.length > 240;   // 不到 3 行就没什么可折的
  const toggle = body.querySelector('.asst-toggle');
  const node = { kind: 'text', text, el, body, seq: m.seq, replyMs: null, thinkMs: 0, long, mode: 'full', manual: false };
  node.setMode = (mode) => {
    node.mode = mode;
    el.classList.toggle('peek', mode === 'peek' && long);
    toggle.hidden = !long;
    toggle.textContent = mode === 'full' ? '▾ 收起' : `▸ 展开（${lines} 行）`;
  };
  toggle.addEventListener('click', () => { node.manual = true; node.setMode(node.mode === 'full' ? 'peek' : 'full'); });
  node.setMode('full');
  return node;
}
/** 框头里的用时：从本次请求开始到这段文本写完 */
function setReplyTime(node, totalMs, thinkMs) {
  node.replyMs = totalMs; node.thinkMs = thinkMs || 0;
  const span = node.body.querySelector('.reply-time');
  span.textContent = `用时 ${fmtDur(totalMs)}${thinkMs ? ` · 其中思考 ${fmtDur(thinkMs)}` : ''}`;
  span.title = '从本次请求开始（上一条用户消息 / 工具结果的时间戳）到这段回复文本写完的时间；思考时长来自 thinkingDurationMs，终端会话里没有这个字段';
}
/** 主线来了新的文本：上一段收成 3 行（除非用户手动展开过），新的一段展开 */
function trackLatestText(parent, node) {
  const prev = parent.latestText;
  if (prev && !prev.manual) prev.setMode('peek');
  parent.latestText = node;
}

/** 思考行：同一条线上连续的 thinking_tokens 进度事件 + 随后只有签名的 thinking 块，合并成一行 */
function makeThinkingNode(m) {
  const { el, body, addEvent } = wrapNode('thinking', m);
  return { kind: 'thinking', el, body, addEvent, seq: m.seq };
}
function setThinkingText(p, inProgress) {
  const tokens = p.tokens ? ` · 约 ${p.tokens} tokens` : '';
  const dur = !inProgress && p.durationMs ? ` · ${fmtDur(p.durationMs)}` : '';
  p.node.body.innerHTML = inProgress ? `<span class="dot"></span> 思考中${tokens}` : `思考${tokens}${dur}`;
}

function makeSubpromptNode(text, m, label) {
  const { el, body } = wrapNode('subprompt', m);
  body.innerHTML = `<details><summary><span class="pill pill-you">提示</span> <span class="lbl"></span></summary><pre></pre></details>`;
  body.querySelector('.lbl').textContent = `${label}（${text.length} 字）`;
  body.querySelector('pre').textContent = text;
  return { kind: 'subprompt', el, seq: m.seq };
}

/** 会话存档里人类说的话：一条醒目的分隔行，Markdown 渲染正文 */
function makePromptNode(ev, m) {
  const { el, body } = wrapNode('prompt', m);
  const when = ev.timestamp ? new Date(ev.timestamp).toLocaleString('zh-CN', { hour12: false }) : '';
  const extra = [ev.turn && `第 ${ev.turn} 轮`, when, ev.images && `${ev.images} 张图片`, ev.prompt_source && ev.prompt_source !== 'typed' && `来源 ${ev.prompt_source}`].filter(Boolean);
  body.innerHTML = `<div class="prompt-head"><span class="pill pill-you">User</span><span class="k"></span></div><div class="md"></div>`;
  body.querySelector('.k').textContent = extra.join(' · ');
  body.querySelector('.md').innerHTML = md(ev.text || '');
  return { kind: 'prompt', el, seq: m.seq, text: ev.text || '' };
}

/** init 事件：运行开头的一行会话信息；后台子智能体唤醒后的再次 init 是"新一轮开始" */
function makeInitNode(ev, m, first) {
  const { el, body } = wrapNode('init', m, { aux: !first });
  const parts = [
    ['标题', ev.title], ['模型', ev.model], ['权限', ev.permissionMode], ev.tools && ['工具', ev.tools.length + ' 个'],
    ['入口', ev.entrypoint], ['Claude Code', ev.claude_code_version], ['工作目录', ev.cwd], ['session', shortId(ev.session_id)],
    ev.timestamp && ['开始于', new Date(ev.timestamp).toLocaleString('zh-CN', { hour12: false })],
  ].filter((x) => x && x[1]);
  body.innerHTML = (first ? `<span class="lbl">${ev.source === 'archive' ? '会话存档' : '会话开始'}</span>` : '<span class="aux-type">system/init</span><span class="lbl">新一轮开始</span>') +
    parts.map(([k, v]) => ` · <span class="k">${esc(k)}</span> ${esc(v)}`).join('');
  return { kind: 'init', el, seq: m.seq };
}

/** 子智能体启动（task_started）：支线的第一行 */
function makeTaskNode(ev, m) {
  const { el, body } = wrapNode('task', m);
  body.innerHTML = `<span class="lbl">子智能体启动</span> · ${esc(ev.subagent_type || '默认类型')} · ${esc(ev.description || '')}${ev.model ? ` · <span class="k">模型</span> ${esc(ev.model)}` : ''}${ev.task_id ? ` · <span class="k">id</span> ${esc(shortId(ev.task_id))}` : ''}` +
    (ev.prompt ? `<details><summary>任务提示词（${ev.prompt.length} 字）</summary><pre></pre></details>` : '');
  if (ev.prompt) body.querySelector('pre').textContent = ev.prompt;
  return { kind: 'task', el, seq: m.seq };
}

/** 子智能体并回（task_notification）：画在启动它的那条线上，颜色和支线一致，点"◄"跳回 Agent 行 */
function makeMergeNode(run, ev, m, tool) {
  const { el, body } = wrapNode('merge', m);
  const ok = ev.status === 'completed';
  if (!ok) el.classList.add('error');
  const desc = toolSummary(tool.name, tool.input, run.cwd);
  const u = ev.usage || {};
  const usage = [u.total_tokens != null && `total_tokens ${fmtTokens(u.total_tokens)}`, u.duration_ms != null && `耗时 ${fmtDur(u.duration_ms)}`, u.tool_uses != null && `${u.tool_uses} 次调用`].filter(Boolean).join(' · ');
  // 主线行的视角统一是"主智能体收到了什么"：本行时间戳是通知送达（出队）的时刻。
  // 子智能体结束的时刻取通知入队的时间；主智能体正在回复时通知在队列里等，两者可能差好几秒。
  const lag = ev.queued_at && m.ts ? Date.parse(m.ts) - Date.parse(ev.queued_at) : NaN;
  const ended = ev.queued_at
    ? ` · <span class="k" title="完成通知入队时刻 ${esc(ev.queued_at)}，即子智能体结束的时刻">子智能体 ${esc(fmtClock(ev.queued_at).slice(0, 8))} 结束</span>` +
      (Number.isFinite(lag) && lag > 500 ? ` · <span class="k" title="主智能体忙着回复时队列不投递，通知等到它空闲才送达">通知排队 ${esc(fmtDur(lag))}</span>` : '')
    : '';
  body.innerHTML = `<button class="lbl merge-back" title="跳到这个子智能体的 Agent 行">◄ 收到${ok ? '完成通知' : '通知：' + esc(ev.status || '')}</button> · ${esc(desc)}${usage ? ' · ' + usage : ''}` +
    (ev.summary ? ` · 返回 ${ev.summary.length} 字` : '') + ended;
  body.querySelector('.merge-back').style.color = tool.laneColor || '';
  if (ev.summary) body.appendChild(collapsibleText(ev.summary, { markdown: true }));
  body.querySelector('.merge-back').addEventListener('click', () => jumpTo(tool.el));
  return { kind: 'merge', el, tool, seq: m.seq, mergeFrom: tool.subLane, laneColor: tool.laneColor,
    durationMs: u.duration_ms, durationTitle: '子智能体总耗时（日志记录）' };
}

/** result 事件：一行本轮数据 */
function makeResultNode(ev, m) {
  const { el, body } = wrapNode('result', m);
  const ok = !ev.is_error;
  const parts = [
    `<span class="lbl ${ok ? 'ok' : 'error'}">${ok ? '✓' : '✕'} result · ${esc(ev.subtype || '')}</span>`,
    typeof ev.total_cost_usd === 'number' && `<span class="k">费用</span> ${fmtCost(ev.total_cost_usd)}`,
    ev.duration_ms != null && `<span class="k">耗时</span> ${fmtDur(ev.duration_ms)}`,
    ev.duration_api_ms != null && `<span class="k">其中 API</span> ${fmtDur(ev.duration_api_ms)}`,
    ev.num_turns != null && `<span class="k">轮数</span> ${ev.num_turns}`,
    ev.stop_reason && `<span class="k">停止原因</span> ${esc(ev.stop_reason)}`,
    ev.session_id && `<span class="k">session</span> ${esc(shortId(ev.session_id))}`,
  ].filter(Boolean);
  if (ev.usage && ev.usage.output_tokens != null) {
    const u = ev.usage;
    parts.push(`<span class="k">输出</span> ${fmtTokens(u.output_tokens)}${u.thinking_tokens ? `（思考 ${fmtTokens(u.thinking_tokens)}）` : ''}`);
    parts.push(`<span class="k">读缓存</span> ${fmtTokens(u.cache_read_input_tokens || 0)}`, `<span class="k">写缓存</span> ${fmtTokens(u.cache_creation_input_tokens || 0)}`);
  }
  if (ev.omitted) {
    const n = Object.values(ev.omitted).reduce((a, b) => a + b, 0);
    if (n) parts.push(`<span class="k" title="${esc(Object.entries(ev.omitted).map(([k, v]) => k + ' ×' + v).join('\n'))}">省略内部记录</span> ${n} 行`);
  }
  body.innerHTML = parts.join(' · ');
  return { kind: 'result', el, seq: m.seq };
}

function makeToolNode(run, block, m) {
  const { id, name, input = {} } = block;
  const isAgent = name === 'Agent' || name === 'Task';
  const { el, body } = wrapNode('tool', m);
  el.dataset.status = 'pending';
  body.innerHTML = `
    <div class="tool-head" title="点击查看完整输入">
      <span class="pill ${isAgent ? 'pill-agent' : 'pill-tool'}"></span>
      <code class="tool-summary"></code>
      <button class="lane-toggle" hidden></button>
      <span class="tool-progress"></span>
      <span class="status pending"><span class="dot"></span>等待中</span>
    </div>
    <div class="tool-detail" hidden></div>`;
  body.querySelector('.pill').textContent = name;
  body.querySelector('.tool-summary').textContent = toolSummary(name, input, run.cwd);
  const node = {
    kind: 'tool', id, name, input, isAgent, status: 'pending', children: [], seq: m.seq,
    calledAt: m.ts,
    pendingThinking: null, lastThinkingTokens: null, lastUserTs: null, msgId: null, msgStart: null, msgThinkMs: 0, pendingThinkMs: 0, latestText: null,
    subLane: null, laneColor: null, branchTo: null, mergeSeq: null, mergeEl: null, mergeStatus: null, laneHidden: false,
    el, body, elStatus: body.querySelector('.status'), elDetail: body.querySelector('.tool-detail'),
    elProgress: body.querySelector('.tool-progress'), elToggle: body.querySelector('.lane-toggle'),
  };
  body.querySelector('.tool-head').addEventListener('click', (e) => {
    if (e.target.closest('.lane-toggle')) return;
    if (node.elDetail.hidden && !node.elDetail.childNodes.length) node.elDetail.appendChild(renderInput(name, input, run.cwd));
    node.elDetail.hidden = !node.elDetail.hidden;
  });
  node.elToggle.addEventListener('click', (e) => { e.stopPropagation(); setLaneHidden(run, node, !node.laneHidden); });
  if (isAgent) ensureSubagent(run, node);
  return node;
}

/** 把一个工具节点变成子智能体的起点：分配支线列和颜色，Agent 标签染色，显示支线开关 */
function ensureSubagent(run, tool) {
  if (tool.subLane != null) return tool;
  tool.isAgent = true;
  let i = run.lanes.findIndex((t) => !t || t.mergeSeq != null);   // 最小的空闲列，并回过的列可复用
  if (i < 0) i = run.lanes.length;
  run.lanes[i] = tool;
  tool.subLane = i + 1;
  tool.laneColor = LANE_COLORS[run.agentCount % LANE_COLORS.length];
  run.agentCount++;
  tool.branchTo = tool.subLane;
  const pill = tool.body.querySelector('.pill');
  pill.className = 'pill pill-agent';
  pill.style.color = tool.laneColor;
  pill.style.background = tool.laneColor + '1F';
  tool.elToggle.hidden = false;
  tool.elToggle.style.color = tool.laneColor;
  updateSubagentLabel(tool);
  // 如果 Agent 行已经画过轨道（非 Agent 名字的工具后来被当成子智能体），补画分出
  if (tool.parent && tool.el.isConnected) { renderRails(run, tool); run.active.set(tool.subLane, { color: tool.laneColor, fg: tool.input.run_in_background !== true }); }
  return tool;
}
function updateSubagentLabel(tool) {
  if (tool.subLane == null) return;
  const n = tool.children.length;
  tool.elToggle.textContent = tool.laneHidden ? `▸ 支线 ${n} 条，已隐藏` : `▾ 支线 ${n} 条`;
}
/** 隐藏/显示一条支线上的所有行（含嵌套在它下面的更深支线）和它的轨道线 */
function setLaneHidden(run, tool, hidden) {
  tool.laneHidden = hidden;
  const under = (node) => { for (let p = node.parent; p; p = p.parent) if (p === tool) return true; return false; };
  for (const n of run.nodes) if (under(n)) n.el.classList.toggle('lane-hidden', hidden);
  const lanes = new Set([tool.subLane]);
  for (const n of run.nodes) if (n.kind === 'tool' && n.subLane != null && under(n)) lanes.add(n.subLane);
  for (const l of lanes) { if (hidden) run.hiddenLanes.add(l); else run.hiddenLanes.delete(l); }
  for (const i of run.el.querySelectorAll('.rails > i')) if (lanes.has(+i.dataset.lane) && !i.classList.contains('rail-dot')) i.classList.toggle('hidden', hidden);
  updateSubagentLabel(tool);
}

function setProgress(tool, text) { tool.elProgress.textContent = text; }

function setToolStatus(tool, status) {
  tool.status = status;
  tool.el.dataset.status = status;
  const label = { pending: '<span class="dot"></span>等待中', background: '<span class="dot"></span>后台运行中', ok: '✓', error: '✕ 错误', aborted: '— 未完成' }[status];
  tool.elStatus.className = `status ${status}`;
  tool.elStatus.innerHTML = label;
}

/** tool_result 到达：更新对应工具行的状态，并把结果作为一个独立节点按到达顺序加进时间线 */
function setToolResult(run, parent, tool, block, m) {
  const text = resultText(block.content);
  const isErr = block.is_error === true;
  // 后台 Agent 的这条结果只是"已启动"，不代表完成：状态改为"后台运行中"，等 task_notification 再打 ✓
  // 交互式会话的 Agent 调用输入里没有 run_in_background，但结果的 toolUseResult.isAsync 说明它是后台的
  const tr = m.ev && (m.ev.tool_use_result || m.ev.toolUseResult);
  if (tool.isAgent && tr && tr.isAsync === true && tool.input.run_in_background !== true) {
    tool.input.run_in_background = true;
    const a = run.active.get(tool.subLane);
    if (a) a.fg = false;
    renderRails(run, tool);
  }
  const isBg = tool.isAgent && tool.input.run_in_background === true;
  const isBackgroundStarted = isBg && !isErr;
  // 按调用 ID 配对后，保存原事件的时间差，供结果行和大纲共同使用。
  const elapsed = Date.parse(m.ts) - Date.parse(tool.calledAt);
  const validDuration = Number.isFinite(elapsed) && elapsed >= 0;
  tool.durationMs = validDuration ? elapsed : null;
  setToolStatus(tool, isErr ? 'error' : isBg ? 'background' : 'ok');
  const { el, body } = wrapNode('toolresult', m);
  if (isErr) el.classList.add('error');
  const head = h('div', 'toolresult-head');
  // 主线行统一用"主智能体收到了什么"来说：工具结果、后台子智能体的启动回执、前台子智能体的返回
  const headLabel = isBackgroundStarted ? '收到启动回执 ←' : tool.isAgent && !isBg ? '收到子智能体的返回 ←' : '结果 ←';
  head.innerHTML = `<span class="k">${headLabel}</span> <span class="pill ${tool.isAgent ? 'pill-agent' : 'pill-tool'}"></span>`;
  head.querySelector('.pill').textContent = tool.name;
  if (isBackgroundStarted) {
    const notice = h('span', 'tool-notice');
    notice.textContent = '· 子智能体已在后台开始运行';
    notice.title = '这是外壳给主智能体的回执，不代表子智能体做完了；做完时主线上会出现"◄ 收到完成通知"';
    head.appendChild(notice);
  }
  if (['Bash', 'Read', 'Edit'].includes(tool.name)) {
    // 使用原事件时间戳，不能用浏览器接收时间计算，否则回放速度会改变耗时。
    const duration = h('span', 'tool-duration');
    duration.textContent = validDuration ? `· 耗时 ${fmtDur(elapsed)}` : '· 耗时无数据';
    duration.title = validDuration ? '工具调用到结果返回的时间间隔（日志时间戳）' : '调用或结果的时间戳缺失、无效，或结果时间早于调用时间';
    head.appendChild(duration);
  }
  if (tool.isAgent && tool.laneColor) { const pl = head.querySelector('.pill'); pl.style.color = tool.laneColor; pl.style.background = tool.laneColor + '1F'; }
  head.title = '点击跳到对应的调用行';
  head.addEventListener('click', () => jumpTo(tool.el));
  body.appendChild(head);
  if (!isBackgroundStarted) {
    body.appendChild(collapsibleText(text || '(无输出)', { headLines: 1, maxChars: 800 }));
  }
  const node = { kind: 'toolresult', el, tool, seq: m.seq };
  // 前台子智能体没有 task_notification 时，它的结果就是并回点
  if (tool.isAgent && !isBg && tool.mergeSeq == null && tool.subLane != null) {
    tool.mergeSeq = m.seq; tool.mergeEl = el; tool.mergeStatus = isErr ? 'error' : 'ok';
    node.mergeFrom = tool.subLane; node.laneColor = tool.laneColor;
    node.durationMs = tool.durationMs;
    node.durationTitle = '前台子智能体调用到返回的时间间隔（日志时间戳）';
  }
  addNode(run, parent, node);
  tool.resultEl = el;
}

function resultText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => (c.type === 'text' ? c.text : `[${c.type}]`)).join('\n');
  return JSON.stringify(content, null, 2);
}

/** 长文本只先显示开头几行，其余折叠成"▸ 另有 N 行，已折叠" */
function collapsibleText(text, { headLines = 1, maxChars = 800, markdown = false } = {}) {
  const wrap = h('div', 'collapsible');
  const pre = document.createElement('pre');
  const lines = text.split('\n');
  if (lines.length <= headLines && text.length <= maxChars) {
    pre.textContent = text;
    wrap.appendChild(pre);
    return wrap;
  }
  let head = lines.slice(0, headLines).join('\n');
  if (head.length > maxChars) head = head.slice(0, maxChars) + '…';
  const hiddenLines = headLines ? Math.max(1, lines.length - head.split('\n').length) : lines.length;
  if (!headLines) pre.hidden = true;
  pre.textContent = head;
  const btn = h('button', 'more');
  let expanded = false;
  const label = () => { btn.textContent = expanded ? '▾ 收起' : `▸ 另有 ${hiddenLines} 行（共 ${lines.length} 行），已折叠`; };
  let full;
  btn.addEventListener('click', () => {
    expanded = !expanded;
    if (markdown) {
      if (!full) { full = h('div', 'md'); full.innerHTML = md(text); wrap.insertBefore(full, btn); }
      pre.hidden = expanded;
      full.hidden = !expanded;
    } else { pre.textContent = expanded ? text : head; pre.hidden = !headLines && !expanded; }
    label();
  });
  label();
  wrap.append(pre, btn);
  return wrap;
}

/** 工具调用那一行显示什么：每种工具挑最有信息量的一个字段 */
function toolSummary(name, input, cwd) {
  const p = (x) => rel(x, cwd);
  switch (name) {
    case 'Bash': return input.command || '';
    case 'Read': case 'Edit': case 'Write': case 'MultiEdit': return p(input.file_path);
    case 'NotebookEdit': return p(input.notebook_path);
    case 'Glob': return `${input.pattern || ''}${input.path ? '  in ' + p(input.path) : ''}`;
    case 'Grep': return `${JSON.stringify(input.pattern || '')}${input.path ? '  in ' + p(input.path) : ''}`;
    case 'Agent': case 'Task': return input.description || (input.prompt || '').slice(0, 80);
    case 'WebFetch': return input.url || '';
    case 'WebSearch': return input.query || '';
    case 'TodoWrite': return `${(input.todos || []).length} 项待办`;
    default: {
      const s = JSON.stringify(input);
      return s.length > 120 ? s.slice(0, 120) + '…' : s;
    }
  }
}

/** 点开工具调用后显示的完整输入 */
function renderInput(name, input, cwd) {
  const box = document.createDocumentFragment();
  const add = (label, text, cls = '') => {
    if (label) { const l = h('div', 'label'); l.textContent = label; box.appendChild(l); }
    const pre = document.createElement('pre');
    if (cls) pre.className = cls;
    pre.textContent = text;
    box.appendChild(pre);
  };
  switch (name) {
    case 'Bash': add(input.description || '', input.command || ''); break;
    case 'Edit':
      add(rel(input.file_path, cwd) + (input.replace_all ? '（替换全部）' : ''), input.old_string || '', 'diff-old');
      add('改为', input.new_string || '', 'diff-new');
      break;
    case 'Write': add(rel(input.file_path, cwd), input.content || ''); break;
    case 'Agent': case 'Task':
      add(`子智能体类型：${input.subagent_type || '默认'}${input.run_in_background ? '（后台）' : ''}`, input.prompt || '');
      break;
    default: add('', JSON.stringify(input, null, 2));
  }
  return box;
}

// ============================================================ 4. 运行结束：判定状态、显示数据
function updateMeta(run) {
  const parts = [];
  if (run.results.length) {
    const last = run.results[run.results.length - 1];
    const cost = last.total_cost_usd;                                       // 同一进程内是累计值，取最后一个
    const dur = run.results.reduce((s, r) => s + (r.duration_ms || 0), 0);
    const turns = run.results.reduce((s, r) => s + (r.num_turns || 0), 0);
    if (typeof cost === 'number') parts.push(fmtCost(cost));
    parts.push(fmtDur(dur), `${turns} 轮`);
  }
  if (run.thinkingTokens) parts.push(`思考约 ${fmtTokens(run.thinkingTokens)}`);
  if (run.eventCount) parts.push(`${run.eventCount} 个事件`);
  if (run.sessionId) parts.push(`session_id <span class="sid">${esc(run.sessionId)}</span>`);
  run.elMeta.innerHTML = parts.join(' · ');
  run.elMeta.hidden = !parts.length;
}

function finishRun(run) {
  clearInterval(run.timer);
  run.endedAt = Date.now();
  const last = run.results[run.results.length - 1];
  let msg = run.error;
  if (!msg) {
    if (run.stopped) msg = '已被用户停止';
    else if (typeof run.exitCode === 'number' && run.exitCode !== 0) {
      msg = `Claude Code 退出码 ${run.exitCode}` + (run.stderr ? `\n${run.stderr.split('\n').slice(-5).join('\n')}` : '');
    } else if (!last) msg = run.exitSignal ? `进程被信号 ${run.exitSignal} 终止` : '运行结束，但没有收到结果事件';
    else if (last.is_error) msg = `结果事件报告错误（${last.subtype}）`;
  }
  run.status = msg ? 'failed' : 'done';
  run.el.dataset.status = run.status;
  run.elStatus.className = `status ${run.status}`;
  run.elStatus.innerHTML = msg ? '✕ 失败' : '✓ 已完成';
  if (msg) { run.elError.textContent = `错误：${msg}`; run.elError.hidden = false; }
  // 还在"等待中 / 后台运行中"的工具调用不能永远转圈
  for (const t of run.tools.values()) if (t.status === 'pending' || t.status === 'background') setToolStatus(t, 'aborted');
  if (!run.replay && !run.archive && run.status === 'done') state.turn++;
  updateMeta(run);
  updateSessionInfo();
  scheduleOutline();
}

// ============================================================ 5. 大纲：分支图（和对话区同一份时间线）
let outlineScheduled = false;
function scheduleOutline() {
  if (outlineScheduled) return;
  outlineScheduled = true;
  requestAnimationFrame(() => { outlineScheduled = false; renderOutline(); });
}

const ROW_H = 24;

function renderOutline() {
  const body = els.outlineBody;
  body.innerHTML = '';
  for (const run of state.runs) {
    const rows = buildGraphRows(run);
    let maxCol = 0;
    for (const r of rows) for (const c of [r.col, r.branchTo || 0, r.from || 0, ...r.activeBefore.map((a) => a.lane)]) if (c > maxCol) maxCol = c;
    const W = LANE_W * (maxCol + 1) + 2;
    const sect = h('div', 'ol-run');
    rows.forEach((r, i) => sect.appendChild(graphRow(r, i === 0, i === rows.length - 1, W)));
    body.appendChild(sect);
  }
}

/**
 * 大纲列：提示词、每轮的最终回答、工具调用、分出、并回；按时间线顺序。
 * "最终回答"是主线上一轮里（两条提示词之间）的最后一段助手文本：中间夹着工具调用的过渡话不列。
 */
function buildGraphRows(run) {
  const rows = [{ seq: 0, col: 0, kind: 'you', label: run.archive ? 'Session' : 'User', cls: 'pill-you', text: run.prompt, target: run.el, status: run.status, color: MAIN_COLOR }];
  const answers = [];
  let lastText = null;   // 当前轮主线上最后一段文本
  const flushAnswer = () => {
    if (lastText) answers.push({ seq: lastText.seq, col: 0, kind: 'answer', label: 'Assistant', cls: 'pill-answer', text: lastText.text.replace(/\s+/g, ' ').slice(0, 80), target: lastText.el, status: 'done', color: MAIN_COLOR, durationMs: lastText.replyMs, durationTitle: '助手回复用时（请求开始到这段文本写完）' + (lastText.thinkMs ? `，其中思考 ${fmtDur(lastText.thinkMs)}` : '') });
    lastText = null;
  };
  for (const n of run.nodes) {
    if (n.kind === 'text' && n.lane === 0) lastText = n;
    if (n.kind === 'prompt') {
      flushAnswer();
      rows.push({ seq: n.seq, col: 0, kind: 'you', label: 'User', cls: 'pill-you', text: n.text.replace(/\s+/g, ' ').slice(0, 80), target: n.el, status: 'done', color: MAIN_COLOR });
    } else if (n.kind === 'tool') {
      const laneColor = n.lane === 0 ? MAIN_COLOR : (n.parent.laneColor || MAIN_COLOR);
      rows.push({
        seq: n.seq, col: n.lane, kind: 'tool', label: n.name, cls: n.isAgent ? 'pill-agent' : 'pill-tool',
        text: toolSummary(n.name, n.input, run.cwd), target: n.el, status: n.status,
        color: n.isAgent ? n.laneColor : laneColor, pillColor: n.isAgent ? n.laneColor : null,
        branchTo: n.subLane, fg: n.isAgent && n.input.run_in_background !== true,
        durationMs: n.isAgent ? null : n.durationMs,
        durationTitle: n.isAgent ? '子智能体总耗时显示在完成行' : '工具调用到结果返回的时间间隔（日志时间戳）',
      });
    } else if (n.mergeFrom != null) {
      const t = n.tool;
      rows.push({ seq: n.seq, col: n.lane, kind: 'merge', from: n.mergeFrom, color: t.laneColor, text: `◄ ${n.kind === 'merge' ? '收到完成通知' : '收到返回'} · ${toolSummary(t.name, t.input, run.cwd)}`, target: n.el, status: t.mergeStatus || 'ok', durationMs: n.durationMs, durationTitle: n.durationTitle });
    }
  }
  if (run.status !== 'running') { flushAnswer(); rows.push({ seq: Infinity, col: 0, kind: 'end', text: run.status === 'done' ? '✓ 已完成' : '✕ 失败', target: run.elMeta, status: run.status, color: MAIN_COLOR }); }
  // 回答行是事后补进去的，按序号插回时间线原位（并回行可能排在它后面）
  if (answers.length) { rows.push(...answers); rows.sort((a, b) => a.seq - b.seq); }
  const active = new Map();
  for (const r of rows) {
    r.activeBefore = [...active].map(([lane, v]) => ({ lane, ...v }));
    r.waitingBefore = [...active.values()].some((v) => v.fg);
    if (r.kind === 'merge') active.delete(r.from);
    if (r.branchTo != null) active.set(r.branchTo, { color: r.color, fg: r.fg });
    r.waitingAfter = [...active.values()].some((v) => v.fg);
  }
  return rows;
}

function graphRow(r, first, last, W) {
  const row = h('button', `ol-row ol-${r.kind}`);
  row.dataset.status = r.status; row.dataset.col = r.col; row.dataset.seq = r.seq;
  if (r.branchTo != null) row.dataset.branch = r.branchTo;
  if (r.from != null) row.dataset.merge = r.from;
  row.insertAdjacentHTML('beforeend', graphSvg(r, first, last, W));
  if (r.seq && isFinite(r.seq)) { const sq = h('span', 'ol-seq'); sq.textContent = `#${r.seq}`; row.appendChild(sq); }
  if (r.label) {
    const p = h('span', `pill ${r.cls}`); p.textContent = r.label;
    if (r.pillColor) { p.style.color = r.pillColor; p.style.background = r.pillColor + '1F'; }
    row.appendChild(p);
  }
  if (r.text) {
    const t = h('span', 'ol-text'); t.textContent = r.text; t.title = r.text;
    if (r.kind === 'merge') t.style.color = r.color;
    row.appendChild(t);
  }
  if (r.kind === 'tool' || r.kind === 'merge' || r.kind === 'answer') {
    const time = h('span', 'ol-duration');
    time.textContent = fmtOutlineDuration(r.durationMs);
    time.title = (r.durationTitle || '耗时') + (time.textContent === '—' ? ' · 暂无数据' : ` · ${r.durationMs} ms`);
    row.appendChild(time);
  }
  row.addEventListener('click', () => jumpTo(r.target));
  return row;
}

function graphSvg(r, first, last, W) {
  const H = ROW_H, mid = H / 2, x = (c) => RAIL_X0 + c * LANE_W;
  const out = [];
  const line = (x1, y1, x2, y2, color, dashed) =>
    out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="1.5"${dashed ? ' stroke-dasharray="2 3"' : ''}/>`);
  if (!first) line(x(0), 0, x(0), mid, MAIN_COLOR, r.waitingBefore);
  if (!last) line(x(0), mid, x(0), H, MAIN_COLOR, r.waitingAfter);
  for (const a of r.activeBefore) {
    const endsHere = r.kind === 'merge' && r.from === a.lane;
    line(x(a.lane), 0, x(a.lane), endsHere ? mid : H, a.color);
  }
  if (r.branchTo != null) { line(x(r.col), mid, x(r.branchTo), mid, r.color); line(x(r.branchTo), mid, x(r.branchTo), H, r.color); }
  if (r.kind === 'merge') line(x(r.from), mid, x(r.col), mid, r.color);
  const open = r.status === 'pending' || r.status === 'running' || r.status === 'background';
  const fill = r.status === 'error' || r.status === 'failed' ? '#A8322E' : open ? '#fff' : r.color;
  const stroke = open ? '#B26B00' : r.color;
  out.push(`<circle cx="${x(r.col)}" cy="${mid}" r="${r.kind === 'you' || r.kind === 'end' ? 3 : 3.5}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`);
  return `<svg class="ol-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${out.join('')}</svg>`;
}

/** 跳到对话区的某个元素：先展开它所在的折叠运行 / 隐藏的支线，再滚动并高亮 */
function jumpTo(target) {
  if (!target) return;
  const runEl = target.closest('.run');
  const run = state.runs.find((r) => r.el === runEl);
  if (run && runEl.classList.contains('collapsed')) collapseRun(run, false);
  if (run && target.classList.contains('lane-hidden')) {
    const node = run.nodes.find((n) => n.el === target);
    for (let p = node && node.parent; p; p = p.parent) if (p.kind === 'tool' && p.laneHidden) setLaneHidden(run, p, false);
  }
  target.scrollIntoView({ behavior: 'smooth', block: 'center' });
  target.classList.remove('flash'); void target.offsetWidth; target.classList.add('flash');
  if (window.innerWidth <= 700) els.outline.classList.remove('open');
}

// ============================================================ 工具函数
function h(tag, cls) { const e = document.createElement(tag); if (cls) e.className = cls; return e; }
function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function md(text) {
  if (window.marked && window.DOMPurify) return DOMPurify.sanitize(marked.parse(text));
  return esc(text).replace(/\n/g, '<br>');   // CDN 不可用时的退化方案
}
function nearBottom() { const c = els.conversation; return c.scrollHeight - c.scrollTop - c.clientHeight < 120; }
function shortId(id) { return id ? String(id).slice(0, 8) + '…' : ''; }
function rel(p, cwd) {
  if (!p) return '';
  const base = (cwd || '').replace(/\/$/, '');
  return base && p.startsWith(base + '/') ? p.slice(base.length + 1) : p;
}
function fmtClock(ts) {
  const d = new Date(ts);
  return isNaN(d) ? String(ts) : d.toLocaleTimeString('zh-CN', { hour12: false }) + '.' + String(d.getMilliseconds()).padStart(3, '0');
}
function fmtOutlineDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = Math.round(ms / 100) / 10;
  if (seconds < 60) return `${seconds}s`;
  const totalSeconds = Math.round(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`;
}
function fmtDur(ms) {
  if (ms == null) return '';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} 秒`;
  return `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`;
}
function fmtCost(v) { return `$${v.toFixed(v < 0.1 ? 3 : 2)}`; }
function fmtTokens(n) { return n >= 1000 ? `${(n / 1000).toFixed(1)}k tokens` : `${n} tokens`; }

// ============================================================ 启动
init();
