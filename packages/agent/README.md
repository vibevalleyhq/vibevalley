# packages/agent

`@vibevalley/agent`：VibeValley 自己的 agent。`src/core` 是循环（`loop.ts`）和工具（`tool.ts`）；其余是 Brain（`brain.ts`）和它带的东西：对话文件、提示开头、压缩、技能、记性、帮手、自己的任务、提醒、MCP 客户端（`mcp.ts`）、编码工具（`coding.ts`）。怎么搭的、四种用法、为什么这样：[VibeValley 自己的 agent](docs/subsystems/brain.md)。

- 按文件导出：`@vibevalley/agent/core/loop`、`@vibevalley/agent/brain`、`@vibevalley/agent/coding`……
- 依赖 `@vibevalley/ai`、`effect`、MCP 的 SDK；不 import 应用、`@vibevalley/i18n`、`@vibevalley/protocol`；`src/core` 不 import Brain 的文件（根目录 `vite.config.ts` 的 lint 查）。
- 不认识农场：给主人看的话、存进库、oar 的农机、`/v1/chat/completions` 都在 `apps/server`（`agent/model.ts`、`runtime/todoStore.ts`、`runtime/vibevalley.ts`、`orchestrator/openai.ts`）。
- 只有 `src/realTime.ts` 能碰墙上的时钟（杀子进程、MCP 超时）；别的时间用 Effect 的 `Clock`。
- 测试：`vp run --filter @vibevalley/agent test`（在 `server:check` 里），模型用 `@vibevalley/ai/testing`，大脑用 `src/testing.ts` 的 `withAgent`。
