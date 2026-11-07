# apps/cli

`vibevalley`, the command line: for the agents on this machine first (Claude Code, Codex, the helpers) and for people
too. It follows the farm's model as a repo tracker's does (`gh issue`): one command is one operation of the server's,
`<resource> [<sub-resource>] <verb>`, typed with effect/cli and asking the server through the generated `VibeValleyApi`;
it loads none of the server and works out nothing the server decides. How it reads and why: [development](docs/development.md#只用命令行派一个活),
[the core](docs/subsystems/core.md).

```
src/main.ts        the root: the groups below, the global flags (--server, --dry-run, --format), how help and failures are said
src/farm.ts        what every command stands on: global flags, SSE frames, ask (the typed client), show (text or --format json), change (--dry-run)
src/issue.ts       issue list|show [--watch]|create|edit|status|comment|review|diff|timeline|delete
src/channel.ts     channel list, channel message list|send|search
src/pkm.ts         the notes: pkm capture|search|radar, pkm journal show, pkm page list|show|save|export|edit
src/repo.ts     repo list|create, agent list|create|delete, session list|show|stop, runtime list|refresh
src/notes.ts       memory list|search|create|delete, cron list|create|edit|delete, artifact list|show|read
src/app.ts         the desktop app's own abilities, over its socket in the farm's home (@vibevalley/home)
src/doctor.ts      this machine's farm: found, reachable, the app, the runtimes, the keys, connecting to this machine
src/chat.ts        `chat [runtime]`: the server's conversation program, handed this terminal (VIBEVALLEY_CHAT); bare `vibevalley` is the help
src/output.ts      stdout for the result, the failure as one JSON line on stderr, exit codes by kind
src/testing.ts     a run in the process against a whole farm (@vibevalley/server/testing)
src/testdata/      the golden answers: help, typical mistakes, refusals and dry runs (vp run golden:update cli)
```

## Rules

- **A command is an operation of the server's**, named by its resource and a standard verb (`list`, `show`, `create`,
  `edit`, `delete`, or the endpoint's own); it calls that one endpoint and leaves what is allowed to the server.
- **Text first, the protocol's shape with `--format json`.** A line leads with the name to use next (`#12`, `#general`).
- **Every command has a description and an example** (`main.test.ts` holds it); the words are in
  `packages/i18n/locales/<lang>/cli.json`.
- **Nothing of the server is imported** but its test farm in the tests: what the server knows is asked over HTTP, and
  the home's files are `@vibevalley/home`'s.
- Run it from the repository with `vp run --filter @vibevalley/cli start <command…>`; the desktop app bundles it
  (`vp pack`, dist/) and installs it as `vibevalley` (`-beta`, `-alpha`).

## Publish an existing branch

The local owner calls `repo pr submit --cwd /absolute/checkout --branch feat/topic --sha <full-sha> --base main --title <title> --body <body>`.
Add `--dry-run --format json` to inspect the request without fetching, checking, pushing, or creating a PR/MR.
From source, prefix the command with `vp run --filter @vibevalley/cli start`. Build with
`vp run --filter @vibevalley/cli build`, then call `node apps/cli/dist/main.mjs repo pr submit ... --server http://127.0.0.1:<port>`.
The command calls `repo.pr.submit` on the server. It does not run Git, gh, or glab locally.
The checkout may be outside the space. A published response includes the confirmed URL and the check status;
`not-run` means that `.vibevalley/check` was absent. See [repository publication](docs/subsystems/repo.md).

## 帮工会话命令

帮工使用启动说明里的绝对命令（独立 worker 入口，含 `--worker-access-file <path>`），不依赖登录 shell 的 PATH。凭证文件由服务端管理，不读取、打印或复制其内容。先运行 `doctor`；失败就报告阻塞。它验证会话身份和工具调用，不代表编码 agent 加载了可选 MCP。

| 子命令 | JSON 参数 |
|---|---|
| `report` | 必填 `summary`；可选 `prSubmit`、`questions`、`checks`、`remember`、`answer`。完整字段和类型见 `report --help` |
| `pr-submit` | 可选 `summary`；需要主人明确授权 |
| `context` | 省略参数读当前工单串；可选 `id`、`before`、`limit`、`unread` |
| `read` | 必填 `uri`，可选 `offset`、`limit` |
| `doctor` | 无参数，认证调用只读会话列表 |

例如在完整命令后追加 `report '{"summary":"完成","prSubmit":false,"checks":[{"criterion":0,"result":"met","proof":"tests passed"}]}'`。参数不能选择其他会话。缺失、无效或撤销凭证不会回退主人 HTTP；工具拒绝返回非零退出码，stderr 保留有界且脱敏的原因。

源码入口带绝对 Node 和 Vite+ 加载器路径；桌面包入口为 `Resources/cli/dist/worker.mjs`，仅此次 CLI 调用设置 `ELECTRON_RUN_AS_NODE=1`。生命周期与启动门槛见[会话](docs/subsystems/session.md)。
