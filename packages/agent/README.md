# packages/agent

`@vibevalley/agent`：VibeValley 自己的 agent。内部按统一二级目录组织：`src/core` 是循环（`loop.ts`）和工具原语（`tool.ts`）；`src/base` 放纯消息、DAG 与提示词；`src/infra` 放文件系统、墙钟与 MCP 客户端（`mcp.ts`、`mcpTransport.ts`）；`src/tools` 放编码、技能、记忆、自身任务与提醒工具（`coding.ts`、`todo.ts` 等）；`src/brain` 放会话、上下文压缩与 Brain 主入口（`brain.ts`）。怎么搭的、四种用法、为什么这样：[VibeValley 自己的 agent](docs/subsystems/brain.md)。

- `package.json` 显式列出跨包使用的子路径，未列出的实现文件不对外开放；已有调用路径保持不变：`@vibevalley/agent/core/loop`、`@vibevalley/agent/brain`、`@vibevalley/agent/coding`……
- 依赖 `@vibevalley/ai`、`@vibevalley/async`、`zod`、MCP 的 SDK，不用 Effect；不 import 应用、`@vibevalley/i18n`、`@vibevalley/protocol`；`src/core` 不 import Brain 的文件，`src/base` 受 `vibevalley/subpackage-layers` 保持纯度（根目录 `vite.config.ts` 的 lint 查）。
- 文件读写经 `src/infra/fs.ts`（`AgentFs`）与 `TranscriptStore` 收口：宿主可传入自己的 `AgentFs`、`fetch`（`web_fetch`）、`clock`（`@vibevalley/async` 的 `Clock`）和 `log`（`AgentLog`，服务端的 `Logger` 就合），独立运行时回退 `node:fs/promises`、全局 `fetch`、系统时钟和控制台；单轮工具调用默认最多 `8` 并发。
- 一轮是可以停下的任务：`Agent.abort()` 让这一轮的 `AbortSignal` 停下，传给模型请求和每个工具的 `execute(args, call, signal)`；工具抛的 `ToolFailed` 是模型读到的失败结果。`makeBrain(options)` 返回的 `Brain` 是 `AsyncDisposable`，`close()`（或 `await using`）先停下并结算这一轮，再放开后台任务和 MCP 服务；`events()` 是 `@vibevalley/async` 的 `Subscription`，在 `agent_closed` 之后结束。
- 不认识农场：给用户看的话、存进库、oar 的农机、`/v1/chat/completions` 都在 `apps/server`（`modules/agent/agent.ts`、`modules/runtime/vibevalley.ts`、`modules/orchestrator/openai.ts`）。
- 只有 `src/infra/realTime.ts` 能碰墙上的时钟（杀子进程、MCP 超时）；别的时间经传进来的 `clock`。
- 测试：`vp run --filter @vibevalley/agent test`（在 `server:check` 里），模型用 `@vibevalley/ai/testing`，大脑用 `src/testing/testing.ts` 的 `withAgent`（默认一个停在 0 的 `testClock()`，测试自己 `adjust` 它）。
