# packages/ai

`@vibevalley/ai` 管语音和转写的无框架运行。对话模型不在这里：助手和帮工经 pi-ai 的 DeepSeek provider 问它（[模型边界](docs/subsystems/brain.md#模型边界)）。

- `package.json` 显式列出跨包使用的子路径，未列出的实现文件不对外开放。
- 依赖 `@vibevalley/provider` 和 `ai@7.0.164` Core，不用 Effect；不 import `@vibevalley/agent`、应用、`@vibevalley/i18n`、`@vibevalley/protocol`（根目录 `vite.config.ts` 的 lint 查）。
- `./transcription` 校验录音（不合格的抛 `UnsupportedFormat`、`EmptyAudio`、`AudioTooLong`）并调用 Core（失败抛 `TranscriptionFailed`，`cause` 是原错误），只收显式模型对象，固定 `maxRetries: 0`，`AbortSignal` 传到模型。返回 warnings、response、provider metadata 和 usage；该版 Core 只在 onEnd 给 usage，因此本地回调保留它，不注册外部遥测。
- 浏览器安全入口 `./audio` 提供 WAV/RMS，`./realtime/moss`、`./realtime/playback`、`./realtime/moss-session`、`./realtime/turns` 提供无 DOM 的 MOSS 会话、样本级播放对账和轮次。它们不加载 npm Core、服务端模型工厂或长期密钥。
- MOSS 的 tagged-v1、chunk/run/turn 完成回执与样本级 cut 保留在专有运行逻辑中；设备、Worklet、Worker、页面 socket 与应用说话人归 web voice。`realtime/sdk.test.ts` 用安装的 SDK 和假 transport 验证其边界，原因见 [语音](docs/subsystems/voice.md#为什么这样)。
- 测试：`vp run --filter @vibevalley/ai test`（在 `server:check` 里）。
