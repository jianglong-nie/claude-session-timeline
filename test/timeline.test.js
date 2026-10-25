const assert = require('node:assert/strict');
// 精简测试：不连服务器，直接把 jsonl 行喂给页面逻辑，检查节点顺序与行号覆盖
const { JSDOM } = require('jsdom'); const fs = require('fs'); const path = require('path');
// 运行：npm test（需先 npm install 安装 jsdom，仅测试用；服务器本身零依赖）
const DIR = path.resolve(__dirname, '..'); const PUB = DIR + '/web';
const RECORDINGS_DIR = __dirname;
(async () => {
  const html = fs.readFileSync(PUB + '/index.html', 'utf8').replace(/<script src="[^"]*"><\/script>/g, '');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'outside-only', pretendToBeVisual: true });
  const { window } = dom; const { document } = window;
  window.TextDecoder = TextDecoder; window.HTMLElement.prototype.scrollIntoView = function () {};
  const jsonResp = (o) => ({ ok: true, status: 200, json: async () => o });
  window.fetch = async (url, opts) => {
    if (url === '/api/config') return jsonResp({ default_cwd: DIR, recordings: fs.readdirSync(RECORDINGS_DIR).filter((f) => f.endsWith('.jsonl')).sort() });
    if (url === '/api/run') {
      const b = JSON.parse(opts.body); const lines = [JSON.stringify({ type: 'run_started', run_id: 't', mode: 'replay', started_at: Date.now() })];
      lines.push(...fs.readFileSync(path.join(RECORDINGS_DIR, path.basename(b.replay)), 'utf8').split('\n').filter((l) => l.trim()), JSON.stringify({ type: 'run_exit', code: 0 }));
      const enc = new TextEncoder();
      return { ok: true, status: 200, body: new ReadableStream({ async start(c) { for (const l of lines) { c.enqueue(enc.encode(l + '\n')); await new Promise((r) => setTimeout(r, 1)); } c.close(); } }) };
    }
    return jsonResp({});
  };
  const errors = []; window.addEventListener('error', (e) => errors.push(e.message));
  window.eval(fs.readFileSync(PUB + '/app.js', 'utf8'));
  await new Promise((r) => setTimeout(r, 300));
  const file = 'demo.jsonl';
  document.querySelector('#replay').value = file; document.querySelector('#run').click();
  for (let i = 0; i < 300 && document.querySelector('#run').disabled; i++) await new Promise((r) => setTimeout(r, 50));
  const runs = document.querySelectorAll('.run'); const run = runs[runs.length - 1];
  const seqOf = (el) => { const g = el.querySelector(':scope > .gutter'); const m = g && g.textContent.match(/^#(\d+)/); return m ? +m[1] : null; };
  // 检查：时间线上所有节点序号严格递增（现在只有一个容器）
  let bad = [];
  { let prev = 0; for (const el of run.querySelector('.run-body').children) { const s = seqOf(el); if (s == null) continue; if (s <= prev) bad.push(`${prev}→${s}`); prev = s; } }
  const total = +(run.querySelector('.run-meta').textContent.match(/(\d+) 个事件/) || [])[1];
  const seqs = new Set([...run.querySelectorAll('.gutter')].flatMap((g) => { const mm = g.textContent.match(/^#(\d+)(?:–(\d+))?$/); if (!mm) return []; const a = +mm[1], b = mm[2] ? +mm[2] : a; return Array.from({ length: b - a + 1 }, (_, i) => a + i); }));
  const missing = []; for (let i = 1; i <= total; i++) if (!seqs.has(i)) missing.push(i);
  console.log(`${file}: 状态=${run.dataset.status} 事件=${total} 缺失=${missing.length ? missing.join(',') : '无'} 顺序倒置=${bad.length ? bad.join(' ') : '无'}`);
  assert.equal(run.dataset.status, 'done', '回放应完成');
  assert.ok(total > 0, '应渲染事件');
  assert.deepEqual(missing, [], '事件序号不应缺失');
  assert.deepEqual(bad, [], '事件序号应严格递增');
  const nodes = [...run.querySelector('.run-body').children];
  const agent = nodes.find((el) => seqOf(el) === 8);
  assert.equal(agent.dataset.status, 'ok', '前台 Agent #8 应完成');
  assert.ok(nodes.find((el) => seqOf(el) === 12).querySelector('.rail[data-lane="0"]').classList.contains('dashed'), '前台 Agent 运行期间主线应为虚线');
  assert.deepEqual(errors, [], '页面不应有 JS 错误');
  dom.window.close();
  console.log('全部通过');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
