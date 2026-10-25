#!/usr/bin/env node
/**
 * export.mjs — 把一个 Claude Code 会话导出成一个自包含的 HTML 文件
 *
 *   node scripts/export.mjs <session-id 或其前缀> [--out <文件>] [--no-open] [--projects-dir <目录>]
 *   node scripts/export.mjs --latest            最近写入的那个会话
 *   node scripts/export.mjs --list              列出能找到的会话
 *   node scripts/export.mjs --session <id>      作为插件命令运行时由 SKILL.md 传入当前会话 id；
 *                                               位置参数优先于它；都没有时退而用环境变量 CLAUDE_CODE_SESSION_ID
 *
 * 做的事：按 id 在 ~/.claude/projects 的各个项目目录下找到存档（目录名的编码不可逆，所以不拼路径，直接扫），
 * 用 lib/session-adapter.js 转成事件数组，和 web/ 下的页面、样式、两个第三方库一起内联进一个 HTML，
 * 写到当前目录，再用系统默认浏览器打开。页面检测到 window.CLAUDE_TIMELINE 就进入静态模式。
 *
 * 退出码：0 成功；2 参数错误；3 找不到会话；4 写文件失败。
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const adapter = require(path.join(ROOT, 'lib', 'session-adapter.js'));

// ---------------------------------------------------------------- 参数
const args = process.argv.slice(2);
const opts = { id: null, session: null, out: null, open: true, projectsDir: null, latest: false, list: false, quiet: false };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '--out' || a === '-o') opts.out = args[++i];
  else if (a === '--session') opts.session = args[++i];
  else if (a === '--no-open') opts.open = false;
  else if (a === '--projects-dir') opts.projectsDir = args[++i];
  else if (a === '--latest') opts.latest = true;
  else if (a === '--list') opts.list = true;
  else if (a === '--quiet' || a === '-q') opts.quiet = true;
  else if (a === '--help' || a === '-h') { usage(); process.exit(0); }
  else if (a.startsWith('-')) { console.error(`未知参数 ${a}`); usage(); process.exit(2); }
  else if (!opts.id) opts.id = a;
  else { console.error(`多余的参数 ${a}`); usage(); process.exit(2); }
}
function usage() {
  console.error('用法: node scripts/export.mjs <session-id|前缀> [--out 文件] [--no-open] [--projects-dir 目录]\n      node scripts/export.mjs --latest | --list');
}

// 存档根目录：CLAUDE_CONFIG_DIR 可以改 ~/.claude 的位置
const projectsDir = opts.projectsDir
  || process.env.CLAUDE_PROJECTS_DIR
  || path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');

// ---------------------------------------------------------------- 找会话
/** 所有存档文件：[{ project, id, file, mtime }]，不解析内容，只看文件名 */
function listSessionFiles() {
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(projectsDir); } catch { return out; }
  for (const d of dirs) {
    const full = path.join(projectsDir, d);
    let names = [];
    try { names = fs.readdirSync(full); } catch { continue; }
    for (const n of names) {
      if (!n.endsWith('.jsonl')) continue;
      const file = path.join(full, n);
      let st; try { st = fs.statSync(file); } catch { continue; }
      if (st.isFile()) out.push({ project: d, id: n.slice(0, -6), file, mtime: st.mtimeMs });
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

function pickSession() {
  const all = listSessionFiles();
  if (!all.length) { console.error(`在 ${projectsDir} 下没有找到任何会话存档`); process.exit(3); }
  if (opts.latest) return all[0];
  const wanted = String(opts.id).toLowerCase();
  let hits = all.filter((s) => s.id.toLowerCase() === wanted);
  if (!hits.length) hits = all.filter((s) => s.id.toLowerCase().startsWith(wanted));
  if (!hits.length) { console.error(`找不到 id 为 ${opts.id} 的会话（在 ${projectsDir} 下扫了 ${all.length} 个文件）`); process.exit(3); }
  if (hits.length > 1 && !hits.every((h) => h.id === hits[0].id)) {
    console.error(`前缀 ${opts.id} 匹配到多个会话，请写长一点：\n` + hits.map((h) => `  ${h.id}  ${h.project}`).join('\n'));
    process.exit(3);
  }
  return hits[0];   // 同一个 id 出现在多个项目目录时（--resume 后换目录），取最近写入的
}

if (opts.list) {
  for (const s of listSessionFiles()) {
    const info = adapter.describeSession(s.file) || {};
    const when = info.started_at ? new Date(info.started_at).toISOString().slice(0, 16).replace('T', ' ') : '';
    console.log(`${s.id}  ${when}  ${(info.title || info.first_prompt || '').replace(/\s+/g, ' ').slice(0, 50)}  [${info.cwd || s.project}]`);
  }
  process.exit(0);
}
if (!opts.id && !opts.latest) opts.id = (opts.session && opts.session.trim()) || process.env.CLAUDE_CODE_SESSION_ID || null;
if (!opts.id && !opts.latest) {
  console.error('没有拿到当前会话 id（--session 为空，环境变量 CLAUDE_CODE_SESSION_ID 也没有）。可以改用 --latest 或直接给 id 前缀。');
  usage(); process.exit(2);
}

const picked = pickSession();

// ---------------------------------------------------------------- 转换
const info = adapter.describeSession(picked.file) || { id: picked.id };
const result = adapter.loadSession(picked.file);
const data = {
  session: { id: picked.id, project: picked.project, cwd: info.cwd || null, title: info.title || null, first_prompt: info.first_prompt || null,
    entrypoint: info.entrypoint || null, version: info.version || null, model: info.model || null, started_at: info.started_at || null,
    prompts: info.prompts, tool_uses: info.tool_uses, subagents: info.subagents, cost_usd: info.cost_usd },
  events: result.events,
  lines: result.lines,
  omitted: result.omitted,
  source_file: picked.file,
  exported_at: new Date().toISOString(),
  generator: 'session-timeline',
};

// ---------------------------------------------------------------- 拼 HTML
const web = (f) => fs.readFileSync(path.join(ROOT, 'web', f), 'utf8');
/** 内联进 <script> 的内容里不能出现 </script>，JSON 里把 </ 写成 <\/ 即可，JS 解析后一模一样 */
const safeJson = (o) => JSON.stringify(o).replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
const inlineScript = (src) => `<script>\n${src.replace(/<\/script>/gi, '<\\/script>')}\n</script>`;

let html = web('index.html');
const replaceOnce = (re, repl) => {
  if (!re.test(html)) { console.error(`模板 web/index.html 里找不到 ${re}`); process.exit(4); }
  html = html.replace(re, () => repl);
};
replaceOnce(/<link rel="stylesheet" href="style.css">/, `<style>\n${web('style.css')}\n</style>`);
replaceOnce(/<script src="vendor\/marked\.min\.js"><\/script>/, inlineScript(web('vendor/marked.min.js')));
replaceOnce(/<script src="vendor\/purify\.min\.js"><\/script>/, inlineScript(web('vendor/purify.min.js')));
replaceOnce(/<script src="app\.js"><\/script>/, `<script>window.CLAUDE_TIMELINE = ${safeJson(data)};</script>\n${inlineScript(web('app.js'))}`);
const title = (data.session.title || data.session.first_prompt || picked.id).replace(/\s+/g, ' ').slice(0, 60);
replaceOnce(/<title>[^<]*<\/title>/, `<title>${title.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))} · Session Timeline</title>`);

// ---------------------------------------------------------------- 写文件、打开
const outFile = path.resolve(opts.out || `session-timeline-${picked.id.slice(0, 8)}.html`);
try { fs.writeFileSync(outFile, html); }
catch (e) { console.error(`写不了 ${outFile}：${e.message}`); process.exit(4); }

if (!opts.quiet) {
  console.error(`会话 ${picked.id}${data.session.title ? ` · ${data.session.title}` : ''}`);
  console.error(`存档 ${picked.file}（${result.lines} 行 → ${result.events.length} 条事件）`);
}
console.log(outFile);

if (opts.open) {
  const cmd = process.platform === 'darwin' ? ['open', [outFile]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', outFile]]
    : ['xdg-open', [outFile]];
  try { spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref(); }
  catch (e) { console.error(`打不开浏览器：${e.message}（文件已经写好）`); }
}
