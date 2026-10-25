#!/usr/bin/env node
/**
 * timeline.mjs — /timeline 命令的入口
 *
 *   node scripts/timeline.mjs [--session <id>] [<id 前缀>] [--no-open]   实时页面（默认）
 *   node scripts/timeline.mjs --html [...]                                 单文件导出，参数同 export.mjs
 *   node scripts/timeline.mjs --list                                       列出会话
 *   node scripts/timeline.mjs --stop                                       关掉后台服务器
 *   node scripts/timeline.mjs --status                                     看服务器在不在
 *
 * 实时页面：保证本机有一个 session-timeline 服务器在后台跑（没有就拉起一个，有就复用），
 * 然后打开 http://127.0.0.1:<端口>/?session=<id>&follow=1。页面每秒追加存档里新写入的内容。
 *
 * 遗留物只有系统临时目录下的 session-timeline/server.json（端口、pid，服务器退出时自删）和 server.log。
 * 服务器没有页面连着且 30 分钟没请求就自己退出。工作目录里不写任何东西。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATE_DIR = path.join(os.tmpdir(), 'session-timeline');
const STATE_FILE = path.join(STATE_DIR, 'server.json');
const LOG_FILE = path.join(STATE_DIR, 'server.log');

// ---------------------------------------------------------------- 参数
const args = process.argv.slice(2);
const opts = { mode: 'live', session: null, id: null, open: true, rest: [] };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--html') opts.mode = 'html';
  else if (a === '--list') opts.mode = 'list';
  else if (a === '--stop') opts.mode = 'stop';
  else if (a === '--status') opts.mode = 'status';
  else if (a === '--session') opts.session = args[++i];
  else if (a === '--no-open') opts.open = false;
  else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  else if (a === '--latest' || a === '--out' || a === '-o' || a === '--projects-dir' || a === '--quiet' || a === '-q') { opts.rest.push(a); if (a === '--out' || a === '-o' || a === '--projects-dir') opts.rest.push(args[++i]); }
  else if (a.startsWith('-')) { console.error(`未知参数 ${a}`); usage(); process.exit(2); }
  else if (!opts.id) opts.id = a;
  else { console.error(`多余的参数 ${a}`); usage(); process.exit(2); }
}
function usage() {
  console.error([
    '用法: /timeline                      打开当前会话的实时页面',
    '      /timeline <id 前缀>             打开指定会话',
    '      /timeline --html [<id 前缀>]    导出单文件 HTML（可分享）',
    '      /timeline --list                列出本机会话',
    '      /timeline --stop                关掉后台服务器',
    '      /timeline --status              看服务器状态',
    '      追加 --no-open 不打开浏览器',
  ].join('\n'));
}

// ---------------------------------------------------------------- 子模式：交给 export.mjs
if (opts.mode === 'html' || opts.mode === 'list') {
  const pass = [path.join(ROOT, 'scripts', 'export.mjs')];
  if (opts.mode === 'list') pass.push('--list');
  else {
    if (opts.id) pass.push(opts.id);
    if (opts.session) pass.push('--session', opts.session);
    if (!opts.open) pass.push('--no-open');
  }
  pass.push(...opts.rest);
  const r = spawnSync(process.execPath, pass, { stdio: 'inherit', env: process.env });
  process.exit(r.status == null ? 1 : r.status);
}

// ---------------------------------------------------------------- 服务器状态
function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}
function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
function health(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/api/health', timeout: 1500 }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { const j = JSON.parse(body); resolve(j && j.generator === 'session-timeline' ? j : null); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}
/** 现有服务器可用就返回它的状态，否则清掉过期的状态文件返回 null */
async function findServer() {
  const s = readState();
  if (!s) return null;
  if (pidAlive(s.pid) && (await health(s.port))) return s;
  try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ }
  return null;
}

if (opts.mode === 'status') {
  const s = await findServer();
  if (s) console.log(`服务器在跑：http://127.0.0.1:${s.port}  pid ${s.pid}  启动于 ${s.started_at}`);
  else console.log('没有在跑的服务器');
  process.exit(0);
}
if (opts.mode === 'stop') {
  const s = readState();
  if (!s) { console.log('没有在跑的服务器'); process.exit(0); }
  try { fs.unlinkSync(STATE_FILE); } catch { /* ignore */ }
  if (pidAlive(s.pid)) { try { process.kill(s.pid, 'SIGTERM'); } catch { /* ignore */ } console.log(`已停止服务器 pid ${s.pid}（端口 ${s.port}）`); }
  else console.log('服务器早已不在，已清理状态文件');
  process.exit(0);
}

// ---------------------------------------------------------------- 实时页面：保证服务器在跑
async function ensureServer() {
  const existing = await findServer();
  if (existing) return existing;
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const log = fs.openSync(LOG_FILE, 'w');   // 每次启动清空
  // 从 Claude Code 里拉起时环境里有 CLAUDECODE 等变量，去掉，免得服务器以后启动 claude 子进程时被当成嵌套会话
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^CLAUDECODE$|^CLAUDE_CODE_/.test(k)) env[k] = v;   // CLAUDE_CONFIG_DIR / CLAUDE_PROJECTS_DIR 要留着
  env.PORT = '0';
  const child = spawn(process.execPath, [path.join(ROOT, 'server.js'), '--state', STATE_FILE], {
    cwd: ROOT, env, detached: true, stdio: ['ignore', log, log],
  });
  child.unref();
  fs.closeSync(log);
  // 等它把端口写进状态文件（最多 5 秒）
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100));
    const s = readState();
    if (s && s.pid === child.pid && (await health(s.port))) return s;
    if (child.exitCode != null) break;
  }
  let tail = '';
  try { tail = fs.readFileSync(LOG_FILE, 'utf8').split('\n').slice(-5).join('\n'); } catch { /* ignore */ }
  console.error(`服务器没有起来。日志 ${LOG_FILE}：\n${tail}`);
  process.exit(5);
}

const sessionId = opts.id || (opts.session && opts.session.trim()) || process.env.CLAUDE_CODE_SESSION_ID || null;
if (!sessionId) {
  console.error('没有拿到当前会话 id（--session 为空，环境变量 CLAUDE_CODE_SESSION_ID 也没有）。可以直接给 id 前缀，或用 --list 查看。');
  process.exit(2);
}
const server = await ensureServer();
const url = `http://127.0.0.1:${server.port}/?session=${encodeURIComponent(sessionId)}&follow=1`;
const idle = server.idle_exit_ms || 0;
console.error(`服务器 http://127.0.0.1:${server.port}（pid ${server.pid}，无页面连接且 ${idle >= 60000 ? Math.round(idle / 60000) + ' 分钟' : Math.round(idle / 1000) + ' 秒'}无请求后自动退出）`);
console.log(url);
if (opts.open) {
  const cmd = process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); }
  catch (e) { console.error(`打不开浏览器：${e.message}（把上面的网址粘到浏览器里即可）`); }
}
