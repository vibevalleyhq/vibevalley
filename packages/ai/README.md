# packages/ai

`@vibevalley/ai`：模型。DeepSeek 的 `chat/completions` 请求和流（`llm.ts`、`request.ts`、`response.ts`）、消息形状（`messages.ts`）、模型表和价格（`models.ts`）、`ModelClient`（`client.ts`）、工具参数的 JSON Schema（`tools.ts`）、照脚本回答的测试模型（`testing.ts`）。在整个 agent 里的位置见 [VibeValley 自己的 agent](docs/subsystems/brain.md)。

- 按文件导出：`@vibevalley/ai/messages`、`@vibevalley/ai/llm`……
- 只依赖 `effect`；不 import `@vibevalley/agent`、应用、`@vibevalley/i18n`、`@vibevalley/protocol`（根目录 `vite.config.ts` 的 lint 查）。
- 黄金数据在 `src/testdata`，从 pi-ai 录下；有意改了请求或读流，`vp run golden:update -- ai` 重写，看过 diff 再留。
- 测试：`vp run --filter @vibevalley/ai test`（在 `server:check` 里）。
