# packages/ai

`@vibevalley/ai` 管模型能力调用和无框架运行。`llm.ts` 将 Provider 的 DeepSeek 流接回现有 agent 事件；`request.ts` 管历史重放、图片降级、缺失工具结果和上下文预算，`response.ts` 管消息折叠、工具参数修补和成本计算。消息形状（`messages.ts`）、`ModelClient`（`client.ts`）、工具参数的 JSON Schema（`tools.ts`）和脚本模型（`testing.ts`）留在这里；`models.ts` 将 Provider 模型目录接到现有模型契约。在整个 agent 里的位置见 [VibeValley 自己的 agent](docs/subsystems/brain.md)。

- `package.json` 显式列出跨包使用的子路径，未列出的实现文件不对外开放；已有调用路径保持不变：`@vibevalley/ai/messages`、`@vibevalley/ai/llm`……
- 依赖 `effect`、`@vibevalley/provider` 和 `ai@7.0.164` Core；不 import `@vibevalley/agent`、应用、`@vibevalley/i18n`、`@vibevalley/protocol`（根目录 `vite.config.ts` 的 lint 查）。
- `./transcription` 校验录音并调用 Core，只收显式模型对象，固定 `maxRetries: 0`，取消传到模型。返回 warnings、response、provider metadata 和 usage；该版 Core 只在 onEnd 给 usage，因此本地回调保留它，不注册外部遥测。
- 浏览器安全入口 `./audio` 提供 WAV/RMS，`./realtime/moss`、`./realtime/playback`、`./realtime/moss-session`、`./realtime/turns` 提供无 DOM 的 MOSS 会话、样本级播放对账和轮次。它们不加载 npm Core、服务端模型工厂或长期密钥。
- MOSS 的 tagged-v1、chunk/run/turn 完成回执与样本级 cut 保留在专有运行逻辑中；设备、Worklet、Worker、页面 socket 与应用说话人归 web voice。`realtime/sdk.test.ts` 用安装的 SDK 和假 transport 验证其边界，原因见 [语音](docs/subsystems/voice.md#为什么这样)。
- DeepSeek 的唯一网络实现、请求编码和厂商字段解码在 Provider；`Llm`/`ModelClient` 及消息/工具契约不变。语言调用不经过 SDK Core，差异依据见 [模型边界](docs/subsystems/brain.md#模型边界)。
- 测试：`vp run --filter @vibevalley/ai test`（在 `server:check` 里）。
