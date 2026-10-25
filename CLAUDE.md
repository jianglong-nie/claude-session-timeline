# session-timeline 开发须知

把 Claude Code 会话存档画成时间线网页的插件。用户在会话里敲 `/timeline` 打开实时页面；`--html` 导出单文件。

## 目录
- `lib/session-adapter.js`：存档（`~/.claude/projects/<目录编码>/<id>.jsonl` + `<id>/subagents/`）→ stream-json 风格事件流。
  `loadSession()` 一次性转换；`SessionConverter` 增量转换（跟随模式）。所有"合成事件"（init、result、task_started、
  task_notification、user_prompt、thinking_tokens）都在这里产生，页面不碰存档格式。
- `web/app.js`：事件流 → 节点 → DOM，以及右侧大纲。三种来源同一条路：真实运行、回放文件、会话存档；
  `window.CLAUDE_TIMELINE` 存在时进入静态模式（导出的单文件）。`init()` 必须在文件末尾调用（静态模式同步执行，前面的 let 要先初始化）。
- `server.js`：静态文件、`/api/run`（live / replay / archive / archive-follow）、`/api/sessions`、`/api/health`。
  `--state <文件>` 进入托管模式：写端口和 pid，无长连接且 30 分钟无请求自动退出并删状态文件。
- `scripts/timeline.mjs`：`/timeline` 入口，保证服务器在跑、打开页面；`--html` 转给 `scripts/export.mjs`。
- `skills/timeline/SKILL.md`：命令本身，用 `!` 行内执行跑脚本，`--session "${CLAUDE_SESSION_ID}"` 传当前会话 id。
- `test/`：`demo.jsonl` 是回放样本，`timeline.test.js` 检查页面回放；不要放未脱敏的会话。

## 开发流程
- 服务器零依赖。页面回放测试先 `npm install`（jsdom），再运行 `npm test`，看退出码，不要只 grep 输出。
  跑完 `rm -rf node_modules`。
- 本目录已注册为本地 marketplace，插件直接从这里读：改 `scripts/`、`lib/`、`web/` 立即生效；改 `SKILL.md`、`plugin.json` 要 `/reload-plugins`。
- 发布：改 `plugin.json` 版本号，`claude plugin validate .`，提交，打 tag，推送。插件名不能以 `claude-` 开头。
- 不要在仓库里留导出的 HTML（已 gitignore）。实时服务器的遗留物只在系统临时目录 `session-timeline/` 下。

## 已定下的显示原则（改页面前先读）
1. 存档里每一行在页面上都有节点，按写入顺序排，永不搬动；丢弃的内部记录只计数。
2. 主线上的每一行都说"主智能体收到了什么 / 做了什么"，时间戳是收到或做的那一刻；支线站在子智能体视角。
   固定用词：启动、结束（取通知入队时刻）、收到 / 送达（出队）。"完成"只出现在"完成通知"里。
3. 回复用时 = 文本块写完 − 请求起点（这条线上最后一条 user 行），不取消息最后一块：同一条消息里后面的块会被前面工具的执行拖后。
4. 标签用 User / Assistant / Session；主线每轮最终回答展开，之前的收 3 行；子智能体回复不加框，折叠 1 行。
5. 存档格式是 Claude Code 内部格式，不认识的行显示为灰色行，不要崩。
