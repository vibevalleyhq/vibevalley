# packages/ai

`@vibevalley/ai`：模型。DeepSeek 的 `chat/completions` 请求和流（`llm.ts`、`request.ts`、`response.ts`）、消息形状（`messages.ts`）、模型表和价格（`models.ts`）、`ModelClient`（`client.ts`）、工具参数的 JSON Schema（`tools.ts`）、照脚本回答的测试模型（`testing.ts`）。在整个 agent 里的位置见 [VibeValley 自己的 agent](docs/subsystems/brain.md)。

- `package.json` 显式列出跨包使用的子路径，未列出的实现文件不对外开放；已有调用路径保持不变：`@vibevalley/ai/messages`、`@vibevalley/ai/llm`……
- 依赖 `effect`、`@vibevalley/provider` 和 `ai@7.0.164` Core；不 import `@vibevalley/agent`、应用、`@vibevalley/i18n`、`@vibevalley/protocol`（根目录 `vite.config.ts` 的 lint 查）。
- `./transcription` 校验录音并调用 Core，只收显式模型对象，固定 `maxRetries: 0`，取消传到模型。返回 warnings、response、provider metadata 和 usage；该版 Core 只在 onEnd 给 usage，因此本地回调保留它，不注册外部遥测。
- 浏览器安全入口 `./audio` 提供 WAV/RMS，`./realtime/moss`、`./realtime/playback`、`./realtime/moss-session`、`./realtime/turns` 提供无 DOM 的 MOSS 会话、样本级播放对账和轮次。它们不加载 npm Core、服务端模型工厂或长期密钥。
- MOSS 的 tagged-v1、chunk/run/turn 完成回执与样本级 cut 未证明与 SDK 实时内核等价，保留专有运行逻辑；设备、Worklet、Worker、页面 socket 与应用说话人归 web voice。DeepSeek 的现有请求与流仍是唯一语言调用路径，不宣称已迁 SDK 语言桥。
- 黄金数据在 `src/testdata`，从 pi-ai 录下；有意改了请求或读流，`vp run golden:update -- ai` 重写，看过 diff 再留。
- 测试：`vp run --filter @vibevalley/ai test`（在 `server:check` 里）。
