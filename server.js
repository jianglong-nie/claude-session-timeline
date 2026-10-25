#!/usr/bin/env node
/**
 * server.js — CS2680 作业 1：Claude Code 网页前端的后端
 *
 * 零依赖，只用 Node 内置模块。职责只有三件事：
 *   1. 托管 public/ 下的静态页面
 *   2. POST /api/run        把 `claude -p ... --output-format stream-json --verbose` 作为子进程启动，
 *                           stdout 的每一行 JSON 事件原样、实时地转发给浏览器（NDJSON 流式响应）。
 *                           请求体带 replay 字段时，改为重放已录好的 demo.jsonl（开发渲染时用，免费且即时）。
 *   3. POST /api/stop/:id   终止一次运行中的子进程（附加功能）
 *   4. GET  /api/sessions    列出 ~/.claude/projects 下的所有会话存档（项目 → 会话）
 *                           POST /api/run 的请求体带 archive: { project, id } 时，用 session-adapter.js 把该会话
 *                           转换成 stream-json 风格事件一次性送给页面；再带 follow: true 则持续跟随文件末尾，
 *                           用来实时看一个正在进行的 Claude Code 会话。
 *
 * 启动：node server.js      然后打开 http://localhost:3000
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const adapter = require('./lib/session-adapter');

const PORT = process.env.PORT !== undefined ? Number(process.env.PORT) : 3000;   // 0 = 让系统分配空闲端口
// 托管模式：由 scripts/timeline.mjs 在后台拉起时传 --state <文件>。服务器把端口和 pid 写进去，
// 没有页面连着且一段时间没有请求就自己退出并删掉该文件，避免后台进程遗留。
const STATE_FILE = (() => { const i = process.argv.indexOf('--state'); return i > 0 ? process.argv[i + 1] : null; })();
const IDLE_EXIT_MS = process.env.IDLE_EXIT_MS !== undefined ? Number(process.env.IDLE_EXIT_MS) : 30 * 60 * 1000;
let openStreams = 0;            // 正在跟随/运行的长连接数
let lastActivity = Date.now();
const PUBLIC_DIR = path.join(__dirname, 'web');
const RECORDINGS_DIR = path.join(__dirname, 'test'); // 回放与测试共用的 demo.jsonl
const CLAUDE_BIN = process.env.CLAUDE_BIN || 'claude';
const REPLAY_DELAY_MS = process.env.REPLAY_DELAY_MS !== undefined ? Number(process.env.REPLAY_DELAY_MS) : 150;

/** 正在进行的运行：run_id -> { stop() } */
const runs = new Map();

// ---------------------------------------------------------------- 小工具

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { data += c; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

/** 把一个可读流按行切开。子进程的 stdout 是按块到达的，一块里可能有半行，所以要自己缓冲。 */
function forEachLine(stream, onLine) {
  let buf = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
  stream.on('end', () => {
    const line = buf.trim();
    if (line) onLine(line);
  });
}

function listRecordings() {
  return fs.readdirSync(RECORDINGS_DIR)
    .filter((f) => f.endsWith('.jsonl'))
    .sort();
}

// ---------------------------------------------------------------- 静态文件

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.map': 'application/json',
  '.png': 'image/png',
};

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const rel = urlPath === '/' ? 'index.html' : urlPath.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: 'forbidden' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

// ---------------------------------------------------------------- 核心：启动一次运行

async function handleRun(req, res) {
  let body;
  try {
    body = JSON.parse((await readBody(req)) || '{}');
  } catch {
    return sendJson(res, 400, { error: '请求体不是合法 JSON' });
  }
  const { cwd, prompt, session_id: sessionId, replay, archive, follow } = body;

  // 流式响应：每行一个 JSON 对象。浏览器用 fetch + ReadableStream 逐行读。
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache',
    'X-Accel-Buffering': 'no',
  });
  const runId = crypto.randomUUID();
  let finished = false;
  openStreams++;
  const emit = (obj) => { if (!finished) res.write(JSON.stringify(obj) + '\n'); };   // 服务器自己造的事件
  const raw = (line) => { if (!finished) res.write(line + '\n'); };                  // claude 输出的原始事件行，原样转发
  const finish = (exitInfo) => {
    if (finished) return;
    emit({ type: 'run_exit', ...exitInfo });
    finished = true;
    openStreams--; lastActivity = Date.now();
    runs.delete(runId);
    res.end();
  };

  // 服务器自己加的第一个事件：让前端知道 run_id（用于停止）、模式、起始时间
  emit({
    type: 'run_started',
    run_id: runId,
    mode: archive ? (follow ? 'archive-follow' : 'archive') : replay ? 'replay' : 'live',
    cwd, prompt, archive: archive || null,
    resumed_session_id: sessionId || null,
    started_at: Date.now(),
  });

  // 浏览器关掉页面/中断请求 → 终止子进程，别让它在后台继续花钱
  res.on('close', () => {
    const r = runs.get(runId);
    if (r && !finished) { r.stop(); runs.delete(runId); }
    if (!finished) { finished = true; openStreams--; lastActivity = Date.now(); }
  });

  if (archive) return startArchive({ archive, follow, runId, emit, raw, finish });
  if (replay) return startReplay({ replay, runId, emit, raw, finish });
  return startLive({ cwd, prompt, sessionId, runId, emit, raw, finish });
}

function startLive({ cwd, prompt, sessionId, runId, emit, raw, finish }) {
  // --- 启动前的校验：失败要给出明确错误，而不是让页面永远等待 ---
  if (!prompt || !prompt.trim()) {
    emit({ type: 'run_error', message: '提示词为空' });
    return finish({ code: 1 });
  }
  let stat = null;
  try { stat = fs.statSync(cwd); } catch { /* 不存在 */ }
  if (!cwd || !stat || !stat.isDirectory()) {
    emit({ type: 'run_error', message: `${cwd || '(空)'} 不是目录` });
    return finish({ code: 1 });
  }

  // --- 组装第 1 部分里的那条命令 ---
  const args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (sessionId) args.push('--resume', sessionId);

  // 如果服务器是从某个 Claude Code 会话的终端里启动的，环境里会有 CLAUDECODE 等变量，
  // 子进程会以为自己是嵌套会话而拒绝启动，所以清掉。
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDECODE$|^CLAUDE_CODE_/.test(k)) env[k] = v;   // CLAUDE_CONFIG_DIR 要留着，子进程才会把会话存到同一个地方

  let child;
  try {
    child = spawn(CLAUDE_BIN, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    emit({ type: 'run_error', message: `无法启动 ${CLAUDE_BIN}：${e.message}` });
    return finish({ code: 1 });
  }
  let stopped = false;
  runs.set(runId, { stop() { stopped = true; child.kill('SIGTERM'); } });

  child.on('error', (e) => {
    // 典型情况：找不到 claude 可执行文件
    emit({ type: 'run_error', message: `无法启动 ${CLAUDE_BIN}：${e.message}` });
    finish({ code: 1 });
  });

  // stdout：每行一个事件，原样转发；万一出现非 JSON 的行（正常不会有），包一层以免前端解析失败
  forEachLine(child.stdout, (line) => {
    try { JSON.parse(line); raw(line); }
    catch { emit({ type: 'raw_stdout', line }); }
  });

  // stderr：攒起来，失败时随 run_exit 一起给前端看（只留尾部，避免爆内存）
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-20000); });

  child.on('close', (code, signal) => {
    finish({ code, signal, stopped, stderr: stderr.trim() });
  });
}

function startReplay({ replay, runId, emit, raw, finish }) {
  const name = path.basename(String(replay));          // 防止 ../ 路径穿越
  const file = path.join(RECORDINGS_DIR, name);
  if (!name.endsWith('.jsonl') || !fs.existsSync(file)) {
    emit({ type: 'run_error', message: `找不到录制文件 ${name}` });
    return finish({ code: 1 });
  }
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  let i = 0;
  const timer = setInterval(() => {
    if (i >= lines.length) {
      clearInterval(timer);
      return finish({ code: 0, replay: true });
    }
    raw(lines[i++]);
  }, REPLAY_DELAY_MS);
  runs.set(runId, { stop() { clearInterval(timer); finish({ code: null, signal: 'SIGTERM', stopped: true, replay: true }); } });
}

// ---------------------------------------------------------------- 会话存档：一次性载入，或跟随正在写入的文件

const FOLLOW_POLL_MS = Number(process.env.FOLLOW_POLL_MS) || 1000;

function startArchive({ archive, follow, runId, emit, raw, finish }) {
  const file = adapter.resolveSessionFile(archive.project, archive.id);
  if (!file) {
    emit({ type: 'run_error', message: `找不到会话存档 ${archive.project}/${archive.id}` });
    return finish({ code: 1 });
  }
  const send = (events) => { for (const ev of events) raw(JSON.stringify(ev)); };

  if (!follow) {
    // 一次性：主文件 + 子智能体文件按时间合并、转换，整批发出
    let result;
    try { result = adapter.loadSession(file); }
    catch (e) { emit({ type: 'run_error', message: `读取会话失败：${e.message}` }); return finish({ code: 1 }); }
    send(result.events);
    return finish({ code: 0, archive: true, lines: result.lines });
  }

  // 跟随：先把已有内容按行喂给增量转换器，然后每秒检查主文件和 subagents/ 下有没有新行
  const sessionId = path.basename(file, '.jsonl');
  const dir = path.join(path.dirname(file), sessionId);
  const conv = new adapter.SessionConverter({ sessionId, dir, meta: adapter.scanMeta(adapter.readJsonl(file)) });
  const tails = new Map();   // 文件 -> { offset, rest }：已读到的字节数和未结束的半行
  const readNew = (f) => {
    let t = tails.get(f);
    if (!t) { t = { offset: 0, rest: '' }; tails.set(f, t); }
    let st;
    try { st = fs.statSync(f); } catch { return []; }
    if (st.size <= t.offset) return [];
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(st.size - t.offset);
    fs.readSync(fd, buf, 0, buf.length, t.offset);
    fs.closeSync(fd);
    t.offset = st.size;
    const text = t.rest + buf.toString('utf8');
    const parts = text.split('\n');
    t.rest = parts.pop();   // 最后一段没有换行，可能是半行，留到下次
    const rows = [];
    for (const l of parts) {
      const line = l.trim();
      if (!line) continue;
      try { rows.push(JSON.parse(line)); } catch { rows.push({ type: 'unparsable', line }); }
    }
    return rows;
  };
  // 首次读取：主文件和子智能体文件里已有的行按时间戳合并排序后再喂给转换器（和一次性载入一致，
  // 否则子智能体的行会整体排在主线之后，支线画不出来）；之后每次轮询只有新增的几行，按到达顺序追加
  const ts = (r) => (r && r.timestamp ? Date.parse(r.timestamp) : NaN);
  const poll = (initial) => {
    const tagged = [];
    const take = (f, src) => { let last = -Infinity; readNew(f).forEach((r, i) => { const t = ts(r); if (!Number.isNaN(t)) last = t; tagged.push({ r, t: last, src, i }); }); };
    take(file, 0);
    adapter.listSubagentFiles(dir).forEach((f, k) => take(f, k + 1));
    if (initial) tagged.sort((a, b) => (a.t - b.t) || (a.src - b.src) || (a.i - b.i));
    const out = [];
    for (const { r } of tagged) out.push(...conv.push(r));
    if (out.length) send(out);
  };
  poll(true);
  const timer = setInterval(() => { try { poll(false); } catch (e) { emit({ type: 'run_error', message: `跟随出错：${e.message}` }); } }, FOLLOW_POLL_MS);
  runs.set(runId, {
    stop() {
      clearInterval(timer);
      try { poll(false); send(conv.finish()); } catch { /* 连接可能已断 */ }
      finish({ code: 0, archive: true, follow: true });
    },
  });
}

// ---------------------------------------------------------------- 路由

const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');
  lastActivity = Date.now();
  try {
    if (req.method === 'GET' && pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, generator: 'session-timeline', pid: process.pid, open_streams: openStreams, managed: !!STATE_FILE });
    }
    if (req.method === 'POST' && pathname === '/api/run') return await handleRun(req, res);
    if (req.method === 'POST' && pathname.startsWith('/api/stop/')) {
      const r = runs.get(pathname.slice('/api/stop/'.length));
      if (!r) return sendJson(res, 404, { error: '没有这个运行，可能已结束' });
      r.stop();
      return sendJson(res, 200, { ok: true });
    }
    if (req.method === 'GET' && pathname === '/api/sessions') {
      return sendJson(res, 200, { projects_dir: adapter.PROJECTS_DIR, projects: adapter.listProjects() });
    }
    if (req.method === 'GET' && pathname === '/api/config') {
      return sendJson(res, 200, { default_cwd: process.cwd(), recordings: listRecordings() });
    }
    if (req.method === 'GET') return serveStatic(req, res);
    sendJson(res, 405, { error: 'method not allowed' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) sendJson(res, 500, { error: String(e) });
    else res.end();
  }
});

server.listen(PORT, '127.0.0.1', () => {
  const port = server.address().port;
  console.log(`Session Timeline 已启动：http://127.0.0.1:${port}`);
  if (STATE_FILE) {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ port, pid: process.pid, started_at: new Date().toISOString(), idle_exit_ms: IDLE_EXIT_MS }));
    console.log(`托管模式：状态文件 ${STATE_FILE}，无连接且 ${fmtIdle(IDLE_EXIT_MS)}无请求后自动退出`);
  }
});

// 托管模式的自动退出：每分钟检查一次；状态文件被别人删了也退出（--stop 或系统清理临时目录）
const fmtIdle = (ms) => (ms >= 60000 ? `${Math.round(ms / 60000)} 分钟` : `${Math.round(ms / 1000)} 秒`);
let exiting = false;
function cleanupAndExit(reason) {
  if (exiting) return;
  exiting = true;
  try { if (STATE_FILE) { const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); if (s.pid === process.pid) fs.unlinkSync(STATE_FILE); } } catch { /* 已不存在 */ }
  console.log(`退出：${reason}`);
  for (const r of runs.values()) { try { r.stop(); } catch { /* ignore */ } }
  // close() 会等 keep-alive 连接自己断开，所以先主动断开，否则要拖到兜底定时器
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
if (STATE_FILE) {
  setInterval(() => {
    if (!fs.existsSync(STATE_FILE)) return cleanupAndExit('状态文件已被删除');
    if (IDLE_EXIT_MS > 0 && openStreams === 0 && Date.now() - lastActivity > IDLE_EXIT_MS) cleanupAndExit(`无连接且 ${fmtIdle(IDLE_EXIT_MS)}无请求`);
  }, Math.min(60 * 1000, Math.max(1000, IDLE_EXIT_MS / 4 || 1000))).unref();
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => cleanupAndExit(`收到 ${sig}`));
}
