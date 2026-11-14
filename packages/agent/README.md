# packages/agent

`@vibevalley/agent`：VibeValley 自己的 agent 带的工具。循环、持久、压缩和子对话是 pi-durable 的，这里只有对话用的我们自己的工具和它们的形状。`src/core` 是工具（`tool.ts` 的 `Tool`、`runTool`、`schemaTool`）、参数的 JSON Schema（`schema.ts`）和 `ToolFailed`；`src/base` 是 DAG 和对模型说的话；`src/infra` 是文件系统、墙钟和 MCP 客户端（`mcp.ts`、`mcpTransport.ts`）；`src/tools` 是技能、记性、自己的任务和 `selfTools`。怎么用、为什么这样：[VibeValley 自己的 agent](docs/subsystems/brain.md)。

- `package.json` 显式列出跨包使用的子路径，未列出的实现文件不对外开放。
- 依赖 `@vibevalley/async`、`zod`、MCP 的 SDK；不 import 应用、`@vibevalley/i18n`、`@vibevalley/protocol`；`src/core` 不 import 包里别的文件，`src/base` 受 `vibevalley/subpackage-layers` 保持纯度（根目录 `vite.config.ts` 的 lint 查）。
- 工具抛的 `ToolFailed` 是模型读到的失败结果；`execute(args, call, signal)` 收这一轮的 `AbortSignal`。服务端的 `agent/durable.ts` 的 `durableTool` 把它包成 pi-durable 的工具。
- 文件读写经 `src/infra/fs.ts`（`AgentFs`），宿主可传入自己的 `AgentFs` 和 `log`（`AgentLog`，服务端的 `Logger` 就合）；只有 `src/infra/realTime.ts` 能碰墙上的时钟（MCP 的超时）。
- 工具给模型看的样子（名字、说明、参数的字节）由 `src/tools/declared.test.ts` 对着 `src/testdata/declared.json` 守着；有意改它时 `VIBEVALLEY_GOLDEN=update` 重写。
- 测试：`vp run --filter @vibevalley/agent test`（在 `server:check` 里）。
