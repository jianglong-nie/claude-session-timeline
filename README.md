# session-timeline

把 Claude Code 的会话画成一条时间线网页：人类提示词、每轮回复和用时、工具调用与结果、子智能体的分出与并回，
全部按存档里的顺序排在一条线上，右侧大纲是同一条线的缩略图。在会话里敲 `/timeline`，当前会话就导出成一个自包含的
HTML 文件并在浏览器里打开；文件不依赖网络、不依赖服务器，可以直接发给别人。

## 安装

在 Claude Code 终端会话里（回答 `y` 添加 marketplace，然后选安装范围）：

```
/plugin install session-timeline --marketplace jianglong-nie/claude-session-timeline
```

从 shell：

```
claude plugin install session-timeline --marketplace jianglong-nie/claude-session-timeline
```

桌面版里 `/plugin` 不可用时：点提示框旁的 +，Plugins，Add marketplace 填 `jianglong-nie/claude-session-timeline`，再 Add plugin。

需要本机有 Node.js 18 以上（导出脚本用 Node 跑，没有其他依赖）。

## 用法

| 命令 | 作用 |
|---|---|
| `/timeline` | 在浏览器里打开当前会话的实时页面：先显示存档里已有的内容，然后每秒追加新写入的内容 |
| `/timeline <id 前缀>` | 打开指定会话的实时页面 |
| `/timeline --html [<id 前缀>]` | 导出单文件 HTML 到工作目录 `session-timeline-<id 前 8 位>.html`，可直接发给别人 |
| `/timeline --list` | 列出本机所有会话的 id、时间、标题 |
| `/timeline --stop` / `--status` | 关掉 / 查看后台服务器 |
| 追加 `--no-open` | 不打开浏览器，只打印网址或文件路径 |

实时页面背后是一个本地服务器（`server.js`），`/timeline` 第一次运行时在后台拉起，之后复用。它没有页面连着且 30 分钟没有请求就自动退出；
只在系统临时目录下留一个 `session-timeline/` 文件夹（`server.json` 记端口和 pid，服务器退出时自删；`server.log` 是日志），工作目录里不写任何东西。
页面顶栏的"重新载入"按钮整页重读；"实时跟随"是增量追加，关掉标签页连接就断。

不进会话也能用：`node scripts/timeline.mjs <id 前缀> [--html] [--list] [--stop]`，或 `node scripts/export.mjs <id 前缀 | --latest | --list> [--out 文件] [--no-open]`。

## 页面怎么读

- 每一行对应存档里的一行记录，左侧 `#N` 是序号，点序号看原始 JSON。
- 左侧轨道列：灰色竖线是主智能体，每个子智能体一条彩色竖线，从 `Agent` 调用行分出，在"◄ 收到完成通知"行并回。
- 主线上的每一行都用"主智能体收到了什么 / 做了什么"来说，时间戳是收到或做的那一刻。子智能体结束的时刻与主智能体收到通知的时刻之间隔着一个消息队列，并回行会标出"子智能体 HH:MM:SS 结束 · 通知排队 N 秒"。
- 助手回复框头的"用时"= 这段文本写完的时间戳 − 本次请求起点；"其中思考"来自存档的 `thinkingDurationMs`，终端会话没有这个字段就不显示。
- 顶栏"显示全部事件"关掉后，外壳注入的说明、本轮耗时、本地命令等灰色行隐藏。

## 两条限制

- 存档是异步写入的。实时页面看到的是已经落盘的内容，模型正在生成的那段要等它写完才出现；`--html` 导出时本轮最后几条消息可能还没落盘，页面顶栏标了导出时刻。
- 存档的 JSONL 格式是 Claude Code 的内部格式，版本升级可能出现新的行类型。转换层对不认识的行一律显示为灰色行并计数，不会崩，但显示可能不完整。

## 开发

```
node server.js                 # 开发服务器：http://localhost:3000，可载入任意会话、实时跟随正在进行的会话
npm install && npm test        # 安装 jsdom，运行 demo.jsonl 的页面回放测试
```

把本目录注册为本地 marketplace 后，改完文件在会话里 `/reload-plugins` 即生效，不需要重装：

```
claude plugin marketplace add /path/to/claude-session-timeline
claude plugin install session-timeline@session-timeline
```

`test/demo.jsonl` 是网页回放和自动化测试共用的事件样本。无需安装 Claude，启动服务器后在网页中选择 `demo.jsonl` 即可回放。
`npm test` 检查回放完成状态、事件序号覆盖与顺序、前台子智能体状态和主线轨道；检查失败时返回非零退出码。

目录：`lib/session-adapter.js` 是存档 → 事件流的转换层；`web/` 是页面；`scripts/timeline.mjs` 是 `/timeline` 的入口（拉起服务器、打开页面），`scripts/export.mjs` 是单文件导出；
`skills/timeline/SKILL.md` 是 `/timeline` 命令；`test/demo.jsonl` 是回放样本，`test/timeline.test.js` 是回放页面测试。

## 许可证

MIT。内联的 [marked](https://github.com/markedjs/marked)（MIT）和 [DOMPurify](https://github.com/cure53/DOMPurify)（Apache-2.0 / MPL-2.0 双许可）保留各自的版权声明。
