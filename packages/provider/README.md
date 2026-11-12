# packages/provider

每个请求经调用者给的 `fetch`（`typeof fetch`）发出，带可选的 `signal` 和时钟；流（SSE、分片）是 `AsyncIterable`；失败是 `Error` 子类（名字和字段照旧），用 `instanceof` 接。

`@vibevalley/provider` 管厂商协议和显式连接，不读环境密钥、runtime 登录或应用设置，不依赖 AI Core、agent、农场协议和应用。根目录 lint 检查这个依赖方向。

| 子路径 | 对外约定 |
| --- | --- |
| `./transcription` | `TranscriptionModelV4` 工厂，经调用者给的 `fetch`，使用 `@ai-sdk/provider@4.0.36`；显式接收 endpoint/model/key/格式，无重试或 URL 下载 |
| `./moss` | MOSS 帧 Schema、PCM/tagged-v1 编码；浏览器可用 |
| `./moss/server`、`./moss/live-models` | Live 显式鉴权连接、握手与稳定模型／快照目录 |
| `./moss/image` | `prepareMossImage` 校验参数；`generateMossImage` 显式凭据提交一次生成，返回 URL，不重试、不下载 |
| `./moss/image-models` | 已适配的生图模型与官方快照；配置选择和生图协议使用同一列表，不从账号目录猜能力 |
| `./moss/files` | 显式凭据上传 Blob、按 ID 查询和删除、分页列出文件；不隐式重试或删除，不接收服务器路径 |
| `./moss/understanding`、`./moss/understanding-models` | Responses 协议与显式 VL 模型目录；图片组或单视频加文本，保留不完整文本和厂商 Token 用量 |
| `./moss/speech`、`./moss/speech-models` | Flash／Pro 及官方快照、语言与格式目录；整段 URL 结果或异步 task ID，不下载、不轮询、不冒充流式 |
| `./moss/speech-stream` | Flash SSE 的任务、实际 PCM 元数据、音频分片和完成事件；有界读取，不猜缺失参数 |
| `./moss/speakers`、`./moss/speakers-models` | 多人语音的说话人映射、同步结果或异步提交，以及显式模型目录 |
| `./moss/voice-design`、`./moss/voice-design-models` | 音色设计预览或显式保存可复用音色；同步结果或异步任务 |
| `./moss/transcription`、`./moss/transcription-models` | 长音频异步转写提交与显式模型目录，保留片段、说话人和用量 |
| `./moss/transcription-stream` | 说话人转写 SSE；保留增量与完成结果，不以断流冒充完成 |
| `./moss/audio-submission` | 多人语音、音色设计和转写共用的单次异步提交；返回 task ID，不轮询 |
| `./moss/vision`、`./moss/vision-models` | 连续视觉 WebSocket 的握手、帧确认、增量文本与结束语义；不负责设备采集 |
| `./moss/audio-tasks` | 按 ID 读取一次音频任务；区分排队、执行、失败及音频／转写结果，不重新提交 |
| `./moss/voices` | 按凭据分页列出音色、显式创建克隆音色；不自动翻页，不虚构官方未提供的删除端点 |
| `./moss/models` | 显式凭据查询 MOSS 账号模型目录；只返回 ID 与归属，不猜能力 |
| `./agora/server` | 声网 SDK 客户端、RTC token 和协议错误 |
| `./agora/captions` | 声网字幕包解码与分片；浏览器可用 |

对话模型（DeepSeek）不在这里：助手和帮工经 pi-ai 的 DeepSeek provider 问它（[模型边界](docs/subsystems/brain.md#模型边界)）。

每个协议固定官方端点，只提交一次：不重试、不跟随重定向、不下载结果 URL、不轮询异步任务；超时、响应体上限和本地输入上限写在各自的 `src/` 文件里，不当成厂商的限制。错误区分未提交、明确拒绝和结果未知；缺失的时长、采样率、用量不猜。调用者要先存下结果 URL 或任务 ID，再单独下载或查询，下载失败不重新提交生成。用途绑定、输入存储、任务、授权和克隆样本的寿命归服务端的 [Media](docs/subsystems/media.md) 和 [AI 服务](docs/subsystems/provider.md)。

浏览器只导入纯协议子路径，不导入服务端工厂。`ask_orchestrator`、页面中继、设置到厂商配置的组装及 RTC 设备由应用负责。实时内核的保留边界见 [语音](docs/subsystems/voice.md#为什么这样)。

检查：`vp run --filter @vibevalley/provider test`；参与 `packages:build` 和 `server:check`。服务端 voice 测试检查经 Core 的真实转写接线和声网通话生命周期。
