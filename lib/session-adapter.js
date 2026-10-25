/**
 * session-adapter.js — 把 Claude Code 的会话存档转换成前端已经认识的 stream-json 风格事件
 *
 * 会话存档在 ~/.claude/projects/<工作目录编码>/<sessionId>.jsonl，子智能体在 <sessionId>/subagents/agent-<id>.jsonl，
 * 旁边的 agent-<id>.meta.json 里的 toolUseId 把它和主线上的 Agent 调用连起来。
 *
 * 存档格式和 `claude -p --output-format stream-json` 的差别，以及这里怎么补：
 *   - 没有 system/init 和 result             → 用第一条带时间戳的行合成 init，结束时用 cost-state 合成 result
 *   - 没有 parent_tool_use_id                 → 子智能体文件里的每一行都打上 meta.toolUseId
 *   - 没有 task_started / task_notification   → 子智能体第一行之前合成 task_started；
 *                                               主线上 origin.kind = task-notification 的 user 行解析成 task_notification
 *   - 有人类提示词（事件流里没有）             → 新事件类型 user_prompt
 *   - thinking 块多了 thinking_tokens 和 thinkingDurationMs → 合成一条 system/thinking_tokens 放在前面
 *   - 一半以上是内部记录（api-request*、queue-operation、mode …） → 丢弃，但计数，写进 init 和 result
 *
 * 两种用法：
 *   loadSession(file)          一次性读完，按时间排序后转换，返回事件数组（页面"载入会话"）
 *   new SessionConverter(...)  增量转换，push(row) 返回事件，供 server.js 跟随正在进行的会话时逐行调用
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// 存档根目录：CLAUDE_PROJECTS_DIR 直接指定；CLAUDE_CONFIG_DIR 可以改 ~/.claude 的位置
const PROJECTS_DIR = process.env.CLAUDE_PROJECTS_DIR || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

/** 纯内部记录，不转换，只计数 */
const DROP = new Set([
  'queue-operation', 'api-request', 'api-request-blob', 'api-request-shape',
  'file-history-snapshot', 'mode', 'permission-mode', 'atis-latch', 'last-prompt',
]);
/** attachment 里有信息量的几种；其余（环境、模型、技能清单、token 提醒等）丢弃 */
const KEEP_ATTACHMENT = new Set(['file', 'selected_lines_in_ide', 'queued_command']);

// ---------------------------------------------------------------- 工具

const ts = (row) => (row && row.timestamp ? Date.parse(row.timestamp) : NaN);
const textOf = (content) => {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
  return '';
};
const unescapeXml = (s) => String(s).replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const tag = (s, name) => { const m = String(s).match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`)); return m ? m[1].trim() : null; };

/** 递归把 base64 图片换成占位符，免得一张截图把页面撑爆 */
function stripImages(x) {
  if (Array.isArray(x)) return x.map(stripImages);
  if (x && typeof x === 'object') {
    if (x.type === 'image' && x.source && typeof x.source.data === 'string') {
      return { ...x, source: { ...x.source, data: `[base64 已省略，${x.source.data.length} 字符]` } };
    }
    const o = {};
    for (const [k, v] of Object.entries(x)) o[k] = stripImages(v);
    return o;
  }
  return x;
}

function readJsonl(file) {
  const rows = [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return rows; }
  for (const line of text.split('\n')) {
    const l = line.trim();
    if (!l) continue;
    try { rows.push(JSON.parse(l)); } catch { rows.push({ type: 'unparsable', line: l }); }
  }
  return rows;
}

// ---------------------------------------------------------------- 增量转换器

class SessionConverter {
  /**
   * @param {object} o
   * @param {string} o.sessionId
   * @param {string} [o.dir]   <sessionId>/ 目录（放 subagents/），没有就不解析子智能体元数据
   * @param {object} [o.meta]  预先扫出来的元数据（title、cost、model…），一次性加载时传
   */
  constructor({ sessionId, dir, meta = {} }) {
    this.sessionId = sessionId;
    this.dir = dir;
    this.meta = { title: null, cost: null, model: null, cwd: null, version: null, permissionMode: null, entrypoint: null, ...meta };
    this.initEmitted = false;
    this.firstTs = null; this.lastTs = null;
    this.prompts = 0;
    this.omitted = {};               // 丢弃的行：type -> 条数
    this.usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, thinking_tokens: 0 };
    this.seenMessages = new Set();   // 同一条 message 会按 content 块拆成多行，usage 只算一次
    this.thinkingCounted = new Set(); // 已经发过 thinking_tokens 的 message id
    this.seenToolUses = new Set();   // 已出现过的 tool_use id：子智能体的行必须排在它的 Agent 调用之后
    this.agentByTool = new Map();    // agentId -> tool_use_id（来自 Agent 调用的 toolUseResult）
    this.asyncTools = new Set(meta.asyncTools || []);   // 一次性加载时预扫出来的后台 Agent 调用 id
    this.agents = new Map();         // agentId -> { toolUseId, started, buffer: [] }
    this.queuedNotifications = new Map();   // task_id -> 完成通知入队的时间（真实完成时刻；送达可能要等主智能体空闲）
  }

  omit(type) { this.omitted[type] = (this.omitted[type] || 0) + 1; }

  /** 喂一行存档，返回 0..n 条前端事件 */
  push(row) {
    if (!row || typeof row !== 'object') return [];
    const type = row.type;
    if (type === 'unparsable') return [{ type: 'raw_stdout', line: row.line }];
    if (type === 'queue-operation' && row.operation === 'enqueue' && typeof row.content === 'string' && row.content.startsWith('<task-notification>')) {
      const id = tag(row.content, 'task-id');
      if (id && row.timestamp && !this.queuedNotifications.has(id)) this.queuedNotifications.set(id, row.timestamp);
    }
    if (DROP.has(type)) { this.omit(type); return []; }
    // 标题和费用不是事件，吸收进元数据（init / result 里显示），同时计入省略行数以便对账
    if (type === 'ai-title') { this.meta.title = row.aiTitle || this.meta.title; this.omit(type); return []; }
    if (type === 'cost-state') { this.meta.cost = row; this.omit(type); return []; }

    const out = [];
    const t = ts(row);
    if (!Number.isNaN(t)) {
      if (this.firstTs == null) this.firstTs = t;
      this.lastTs = t;
    }
    if (!this.initEmitted) {
      this.initEmitted = true;
      for (const k of ['cwd', 'version', 'permissionMode', 'entrypoint']) if (row[k] && !this.meta[k]) this.meta[k] = row[k];
      out.push(this.makeInit(row));
    }

    // 子智能体的行：找它的 Agent 调用；调用还没出现就先攒着
    const agentId = row.agentId || (row.isSidechain ? row.agentId : null);
    if (agentId) {
      const a = this.agentFor(agentId);
      if (!a.toolUseId || !this.seenToolUses.has(a.toolUseId)) { a.buffer.push(row); return out; }
      out.push(...this.convertAgentRow(row, a));
      return out;
    }

    out.push(...this.convertRow(row, null));
    return out;
  }

  agentFor(agentId) {
    let a = this.agents.get(agentId);
    if (!a) {
      a = { agentId, toolUseId: this.agentByTool.get(agentId) || null, meta: null, started: false, buffer: [] };
      this.agents.set(agentId, a);
    }
    if (!a.meta && this.dir) {
      try {
        a.meta = JSON.parse(fs.readFileSync(path.join(this.dir, 'subagents', `agent-${agentId}.meta.json`), 'utf8'));
        if (a.meta.toolUseId) a.toolUseId = a.meta.toolUseId;
      } catch { /* 还没写出来，或没有 */ }
    }
    if (!a.toolUseId && this.agentByTool.has(agentId)) a.toolUseId = this.agentByTool.get(agentId);
    return a;
  }

  convertAgentRow(row, a) {
    const out = [];
    if (!a.started) {
      a.started = true;
      const m = a.meta || {};
      out.push({
        type: 'system', subtype: 'task_started', tool_use_id: a.toolUseId, task_id: a.agentId,
        subagent_type: m.agentType || null, description: m.description || null,
        model: m.resolvedModel || null, request_shape: m.requestShape || null,
        timestamp: row.timestamp, session_id: this.sessionId, _synthetic: true,
      });
    }
    out.push(...this.convertRow(row, a.toolUseId));
    return out;
  }

  /** Agent 调用出现后，把为它攒着的子智能体行放出来 */
  flushAgents(out) {
    for (const a of this.agents.values()) {
      if (!a.toolUseId) a.toolUseId = this.agentByTool.get(a.agentId) || null;
      if (!a.buffer.length || !a.toolUseId || !this.seenToolUses.has(a.toolUseId)) continue;
      const rows = a.buffer; a.buffer = [];
      for (const r of rows) out.push(...this.convertAgentRow(r, a));
    }
  }

  convertRow(row, parentToolUseId) {
    const base = { timestamp: row.timestamp, session_id: this.sessionId, uuid: row.uuid, parent_tool_use_id: parentToolUseId };
    switch (row.type) {
      case 'assistant': return this.convertAssistant(row, base);
      case 'user': return this.convertUser(row, base);
      case 'system': return [this.convertSystem(row, base)];
      case 'attachment': return this.convertAttachment(row, base);
      default:
        this.omit(row.type);
        return [];
    }
  }

  convertAssistant(row, base) {
    const out = [];
    const msg = row.message || {};
    const content = Array.isArray(msg.content) ? msg.content : [];
    if (msg.model && !this.meta.model) this.meta.model = msg.model;
    if (msg.usage && msg.id && !this.seenMessages.has(msg.id)) {
      this.seenMessages.add(msg.id);
      const u = msg.usage;
      this.usage.input_tokens += u.input_tokens || 0;
      this.usage.output_tokens += u.output_tokens || 0;
      this.usage.cache_read_input_tokens += u.cache_read_input_tokens || 0;
      this.usage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
      this.usage.thinking_tokens += (u.output_tokens_details && u.output_tokens_details.thinking_tokens) || 0;
    }
    for (const b of content) {
      if (b.type === 'tool_use') {
        this.seenToolUses.add(b.id);
        // 交互式会话的 Agent 调用输入里没有 run_in_background；预扫知道它是后台的就补上，前端据此画轨道
        if ((b.name === 'Agent' || b.name === 'Task') && this.asyncTools.has(b.id) && b.input && b.input.run_in_background !== true) {
          b.input = { ...b.input, run_in_background: true };
        }
      }
      if (b.type === 'thinking' && msg.id && !this.thinkingCounted.has(msg.id)) {
        // 同一条消息的多个 thinking 块共用一份 usage，token 数只记在第一块上
        this.thinkingCounted.add(msg.id);
        const tokens = (msg.usage && msg.usage.output_tokens_details && msg.usage.output_tokens_details.thinking_tokens) || 0;
        if (tokens || row.thinkingDurationMs) {
          out.push({ ...base, type: 'system', subtype: 'thinking_tokens', estimated_tokens: tokens, estimated_tokens_delta: tokens, duration_ms: row.thinkingDurationMs || null, _synthetic: true });
        }
      }
    }
    const ev = { ...base, type: 'assistant', message: stripImages(msg) };
    if (row.isApiErrorMessage) ev.is_api_error = true;
    out.push(ev);
    this.flushAgents(out);
    return out;
  }

  convertUser(row, base) {
    const content = row.message && row.message.content;
    const blocks = Array.isArray(content) ? content : null;
    const hasToolResult = blocks && blocks.some((b) => b && b.type === 'tool_result');

    if (hasToolResult) {
      // Agent 调用的结果里带着 agentId：记下来，子智能体文件缺 meta.json 时靠它配对
      const tr = row.toolUseResult;
      if (tr && typeof tr === 'object' && tr.agentId) {
        for (const b of blocks) if (b.type === 'tool_result') this.agentByTool.set(tr.agentId, b.tool_use_id);
      }
      const ev = { ...base, type: 'user', message: stripImages(row.message), tool_use_result: stripImages(tr) };
      const out = [ev];
      this.flushAgents(out);
      return out;
    }

    const text = textOf(content);
    const origin = (row.origin && row.origin.kind) || null;
    const images = blocks ? blocks.filter((b) => b && b.type === 'image').length : 0;

    // 子智能体支线：外壳塞给它的说明（isMeta，比如"报告要用 SubagentHandback 交付"）是灰色行；
    // 其余 user 行是主智能体写的任务（或后续发给它的消息），原样当 user 事件，前端显示为"子智能体收到的任务"
    if (base.parent_tool_use_id) {
      if (row.isMeta) return [{ ...base, type: 'system', subtype: 'meta_message', from_user_row: true, text: `外壳注入的指令（${text.length} 字）`, detail: text }];
      return [{ ...base, type: 'user', message: stripImages(row.message) }];
    }

    if (origin === 'task-notification' || text.startsWith('<task-notification>')) {
      const status = tag(text, 'status') || 'completed';
      const result = tag(text, 'result');
      const taskId = tag(text, 'task-id');
      return [{
        ...base, type: 'system', subtype: 'task_notification', _synthetic: true, from_user_row: true,
        tool_use_id: tag(text, 'tool-use-id'), task_id: taskId, status,
        queued_at: (taskId && this.queuedNotifications.get(taskId)) || null,
        description: tag(text, 'summary'), summary: result ? unescapeXml(result) : null,
      }];
    }
    if (origin === 'peer' || /<agent-message\b/.test(text)) {
      return [{ ...base, type: 'system', subtype: 'agent_message', from_user_row: true, text: `收到子智能体的报告 · ${text.length} 字 · 经队列转交`, detail: text }];
    }
    if (/^\[Request interrupted/.test(text)) {
      return [{ ...base, type: 'system', subtype: 'user_interrupt', from_user_row: true, text: `用户中断 · ${text}` }];
    }
    if (row.isMeta) {
      return [{ ...base, type: 'system', subtype: 'meta_message', from_user_row: true, text: `外壳注入的消息（${text.length} 字）`, detail: text }];
    }
    this.prompts++;
    return [{
      ...base, type: 'user_prompt', text, images, origin, prompt_source: row.promptSource || null,
      turn: (row.turnPosition && row.turnPosition.promptIndex) || this.prompts,
    }];
  }

  convertSystem(row, base) {
    const ev = { ...base, type: 'system', subtype: row.subtype || 'unknown', level: row.level || null };
    switch (row.subtype) {
      case 'turn_duration':
        ev.duration_ms = row.durationMs; ev.message_count = row.messageCount;
        ev.text = `本轮耗时 ${fmtDur(row.durationMs)} · 上下文 ${row.messageCount} 条消息`;
        break;
      case 'local_command': {
        // 两种形态：<command-name>/resume</command-name>… 是命令本身，<local-command-stdout>…</local-command-stdout> 是它的输出
        const name = tag(row.content, 'command-name'), args = tag(row.content, 'command-args') || '';
        const stdout = tag(row.content, 'local-command-stdout');
        ev.text = name ? `本地命令 ${name}${args ? ' ' + args : ''}` : stdout != null ? `本地命令输出 · ${stdout.slice(0, 160)}` : `本地命令 · ${String(row.content || '').slice(0, 160)}`;
        break;
      }
      case 'api_error': {
        const e = row.error || {};
        ev.text = `API 错误 · ${e.formatted || e.message || ''}${row.retryAttempt ? ` · 重试 ${row.retryAttempt}/${row.maxRetries}` : ''}`;
        ev.level = 'error';
        break;
      }
      case 'informational': ev.text = row.content || ''; break;
      default: ev.text = row.content || JSON.stringify(row).slice(0, 200);
    }
    return ev;
  }

  convertAttachment(row, base) {
    const a = row.attachment || {};
    if (!KEEP_ATTACHMENT.has(a.type)) { this.omit(`attachment/${a.type}`); return []; }
    const ev = { ...base, type: 'system', subtype: `attachment/${a.type}` };
    if (a.type === 'file') {
      const c = (a.content && a.content.file && a.content.file.content) || '';
      ev.text = `提示词里 @ 了文件 ${a.filename}（${c.length} 字已送入上下文）`;
    } else if (a.type === 'selected_lines_in_ide') {
      ev.text = `IDE 中选中 ${a.displayPath || a.filename} 第 ${a.lineStart}–${a.lineEnd} 行`;
      ev.detail = a.content || null;
    } else if (a.type === 'queued_command') {
      ev.text = `排队送入的消息（${(a.prompt || '').length} 字）`; ev.detail = a.prompt || null;
    }
    return [ev];
  }

  makeInit(row) {
    return {
      type: 'system', subtype: 'init', _synthetic: true, source: 'archive',
      session_id: this.sessionId, cwd: this.meta.cwd || row.cwd || null, model: this.meta.model || null,
      permissionMode: this.meta.permissionMode || row.permissionMode || null,
      claude_code_version: this.meta.version || row.version || null, entrypoint: this.meta.entrypoint || row.entrypoint || null,
      title: this.meta.title || null, git_branch: row.gitBranch || null, timestamp: row.timestamp || null,
    };
  }

  /** 会话结束（文件读完，或跟随被停止）：把还攒着的子智能体行放出来，再合成 result */
  finish() {
    const out = [];
    for (const a of this.agents.values()) {
      if (!a.buffer.length) continue;
      out.push({ type: 'system', subtype: 'adapter_warning', text: `子智能体 ${a.agentId} 的 ${a.buffer.length} 行找不到对应的 Agent 调用（缺 meta.json？），按主线显示`, level: 'error' });
      const rows = a.buffer; a.buffer = [];
      for (const r of rows) out.push(...this.convertRow(r, null));
    }
    const cost = this.meta.cost;
    const ev = {
      type: 'result', subtype: 'session_end', is_error: false, _synthetic: true, session_id: this.sessionId,
      num_turns: this.prompts, usage: { ...this.usage }, omitted: { ...this.omitted },
      duration_ms: this.firstTs != null && this.lastTs != null ? this.lastTs - this.firstTs : null,
      title: this.meta.title || null,
    };
    if (cost) {
      ev.total_cost_usd = cost.totalCostUSD;
      ev.duration_api_ms = cost.totalAPIDuration;
      ev.cost_state = { totalToolDuration: cost.totalToolDuration, totalLinesAdded: cost.totalLinesAdded, totalLinesRemoved: cost.totalLinesRemoved, modelUsage: cost.modelUsage };
    }
    out.push(ev);
    return out;
  }
}

function fmtDur(ms) {
  if (ms == null) return '?';
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} 秒`;
  return `${Math.floor(ms / 60000)} 分 ${Math.round((ms % 60000) / 1000)} 秒`;
}

// ---------------------------------------------------------------- 一次性加载

/** 列出一个会话的子智能体文件 */
function listSubagentFiles(dir) {
  const sub = path.join(dir, 'subagents');
  let names = [];
  try { names = fs.readdirSync(sub); } catch { return []; }
  return names.filter((n) => /^agent-.*\.jsonl$/.test(n)).sort().map((n) => path.join(sub, n));
}

/** 预扫元数据：标题、费用、模型等，一次性加载时让 init 一开始就完整 */
function scanMeta(rows) {
  const meta = { asyncTools: [] };
  for (const r of rows) {
    if (r.type === 'user' && r.toolUseResult && r.toolUseResult.isAsync === true && Array.isArray(r.message && r.message.content)) {
      for (const b of r.message.content) if (b.type === 'tool_result') meta.asyncTools.push(b.tool_use_id);
    }
    if (r.type === 'ai-title' && r.aiTitle) meta.title = r.aiTitle;
    else if (r.type === 'cost-state') meta.cost = r;
    else if (r.type === 'assistant' && !meta.model && r.message && r.message.model) meta.model = r.message.model;
    else if (r.type === 'user' && !meta.cwd && r.cwd) { meta.cwd = r.cwd; meta.version = r.version; meta.entrypoint = r.entrypoint; meta.permissionMode = r.permissionMode; }
  }
  return meta;
}

/**
 * 读一个会话存档（主文件 + 子智能体文件），按时间戳合并后转换成事件数组。
 * 没有时间戳的行沿用同文件上一行的时间；时间相同时主文件在前。
 */
function loadSession(file) {
  const sessionId = path.basename(file, '.jsonl');
  const dir = path.join(path.dirname(file), sessionId);
  const main = readJsonl(file);
  const all = [];
  const tagRows = (rows, src) => {
    let last = -Infinity;
    rows.forEach((r, i) => { const t = ts(r); if (!Number.isNaN(t)) last = t; all.push({ r, t: last, src, i }); });
  };
  tagRows(main, 0);
  listSubagentFiles(dir).forEach((f, k) => tagRows(readJsonl(f), k + 1));
  all.sort((a, b) => (a.t - b.t) || (a.src - b.src) || (a.i - b.i));

  const conv = new SessionConverter({ sessionId, dir, meta: scanMeta(main) });
  const events = [];
  for (const { r } of all) events.push(...conv.push(r));
  events.push(...conv.finish());
  return { sessionId, events, meta: conv.meta, omitted: conv.omitted, lines: all.length };
}

// ---------------------------------------------------------------- 会话列表

const listCache = new Map();   // file -> { key, info }

/** 一个会话的摘要（给选择器用）；按文件大小+修改时间缓存 */
function describeSession(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = listCache.get(file);
  if (hit && hit.key === key) return hit.info;
  const sessionId = path.basename(file, '.jsonl');
  const rows = readJsonl(file);
  const info = {
    id: sessionId, file, lines: rows.length, mtime: st.mtimeMs, size: st.size,
    title: null, first_prompt: null, cwd: null, entrypoint: null, version: null, model: null,
    started_at: null, ended_at: null, prompts: 0, tool_uses: 0, cost_usd: null,
    subagents: listSubagentFiles(path.join(path.dirname(file), sessionId)).length,
  };
  for (const r of rows) {
    if (r.type === 'ai-title' && r.aiTitle) info.title = r.aiTitle;
    else if (r.type === 'cost-state') info.cost_usd = r.totalCostUSD;
    if (r.timestamp) { if (!info.started_at) info.started_at = r.timestamp; info.ended_at = r.timestamp; }
    if (r.type === 'user' && !r.isSidechain) {
      if (!info.cwd && r.cwd) { info.cwd = r.cwd; info.entrypoint = r.entrypoint; info.version = r.version; }
      const c = r.message && r.message.content;
      const isToolResult = Array.isArray(c) && c.some((b) => b && b.type === 'tool_result');
      const origin = r.origin && r.origin.kind;
      if (!isToolResult && !r.isMeta && origin !== 'task-notification' && origin !== 'peer') {
        const text = textOf(c);
        if (text && !text.startsWith('<task-notification>') && !/^\[Request interrupted/.test(text)) {
          info.prompts++;
          if (!info.first_prompt) info.first_prompt = text.slice(0, 200);
        }
      }
    } else if (r.type === 'assistant' && r.message) {
      if (!info.model && r.message.model) info.model = r.message.model;
      for (const b of r.message.content || []) if (b.type === 'tool_use') info.tool_uses++;
    }
  }
  listCache.set(file, { key, info });
  return info;
}

/** 所有项目及其会话；项目名用会话里记录的真实工作目录（目录编码不可逆） */
function listProjects(projectsDir = PROJECTS_DIR) {
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir).filter((d) => !d.startsWith('.')); } catch { return []; }
  const projects = [];
  for (const d of dirs) {
    const full = path.join(projectsDir, d);
    let files = [];
    try { files = fs.readdirSync(full).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
    const sessions = files.map((f) => describeSession(path.join(full, f))).filter(Boolean);
    if (!sessions.length) continue;
    sessions.sort((a, b) => b.mtime - a.mtime);
    const cwd = (sessions.find((s) => s.cwd) || {}).cwd || null;
    projects.push({ dir: d, cwd, sessions, latest: sessions[0].mtime });
  }
  projects.sort((a, b) => b.latest - a.latest);
  return projects;
}

/** 把选择器送回来的 { project, id } 变成安全的文件路径（不许路径穿越） */
function resolveSessionFile(project, id, projectsDir = PROJECTS_DIR) {
  if (!project || !id || project !== path.basename(project) || id !== path.basename(id) || !/^[\w-]+$/.test(id)) return null;
  const file = path.join(projectsDir, project, `${id}.jsonl`);
  return fs.existsSync(file) ? file : null;
}

module.exports = { PROJECTS_DIR, SessionConverter, loadSession, listProjects, describeSession, resolveSessionFile, listSubagentFiles, readJsonl, scanMeta };
