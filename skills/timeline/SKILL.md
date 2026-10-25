---
name: timeline
description: 打开当前 Claude Code 会话的实时时间线网页（主线、子智能体支线、工具调用、每轮回复用时），页面每秒追加存档里新写入的内容。也可导出单文件 HTML。
argument-hint: "[<会话 id 前缀>] [--html] [--list] [--stop] [--status] [--no-open]"
disable-model-invocation: true
allowed-tools: Bash(node:*)
---

命令脚本已经运行完毕，输出如下。stdout 的最后一行是打开的网址（或 `--html` 时生成的文件路径）；其余行是服务器信息或错误说明。

```!
node "${CLAUDE_PLUGIN_ROOT}/scripts/timeline.mjs" --session "${CLAUDE_SESSION_ID}" $ARGUMENTS 2>&1
```

根据上面的输出回复用户，不要再运行脚本，也不要读取网址或文件：

- 默认（实时页面）：说明页面已在浏览器打开，给出网址；页面会每秒追加这个会话新写入的内容，顶栏有"重新载入"按钮。提一句后台服务器没有页面连着且 30 分钟无请求会自动退出，`/timeline --stop` 可立即关掉；它只在系统临时目录下留一个 `session-timeline/` 文件夹，工作目录里不写任何东西。
- `--html`：说明文件已生成，给出完整路径；提醒存档是异步写入的，本轮最后几条消息可能还没落盘，页面顶栏标了导出时刻。
- `--list`：把列表原样转给用户，提示可以用 `/timeline <id 前缀>` 打开其中任意一个。
- `--stop` / `--status`：转述结果。
- 出错时（找不到会话、前缀匹配到多个、服务器没起来、找不到 node）：转述原因；服务器没起来的话给出日志路径。找不到当前会话的话，建议 `/timeline --list` 后用 id 前缀。
