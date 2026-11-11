# packages/agent

`@vibevalley/agent`：VibeValley 自己的 agent。内部按统一二级目录组织：`src/core` 是循环（`loop.ts`）和工具原语（`tool.ts`）；`src/base` 放纯消息、DAG 与提示词；`src/infra` 放文件系统、墙钟与 MCP 客户端（`mcp.ts`、`mcpTransport.ts`）；`src/tools` 放编码、技能、记忆、自身任务与提醒工具（`coding.ts`、`todo.ts` 等）；`src/brain` 放会话、上下文压缩与 Brain 主入口（`brain.ts`）。怎么搭的、四种用法、为什么这样：[VibeValley 自己的 agent](docs/subsystems/brain.md)。

- `package.json` 显式列出跨包使用的子路径，未列出的实现文件不对外开放；已有调用路径保持不变：`@vibevalley/agent/core/loop`、`@vibevalley/agent/brain`、`@vibevalley/agent/coding`……
- 依赖 `@vibevalley/ai`、`effect`、MCP 的 SDK；不 import 应用、`@vibevalley/i18n`、`@vibevalley/protocol`；`src/core` 不 import Brain 的文件，`src/base` 受 `vibevalley/subpackage-layers` 保持纯度，源码统一受 `vibevalley/promise-boundary` 约束（根目录 `vite.config.ts` 的 lint 查）。
- 文件读写经 `src/infra/fs.ts`（`AgentFs`）与 `TranscriptStore` 收口：宿主可传入 Effect `FileSystem` 与 `HttpClient`，独立运行时回退本机默认实现；单轮工具调用默认最多 `8` 并发。
- 不认识农场：给用户看的话、存进库、oar 的农机、`/v1/chat/completions` 都在 `apps/server`（`modules/agent/agent.ts`、`modules/runtime/vibevalley.ts`、`modules/orchestrator/openai.ts`）。
- 只有 `src/infra/realTime.ts` 能碰墙上的时钟（杀子进程、MCP 超时）；别的时间用 Effect 的 `Clock`。
- 测试：`vp run --filter @vibevalley/agent test`（在 `server:check` 里），模型用 `@vibevalley/ai/testing`，大脑用 `src/testing/testing.ts` 的 `withAgent`。
