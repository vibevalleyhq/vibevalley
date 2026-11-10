# packages/provider

`@vibevalley/provider` 管厂商协议和显式连接，不读环境密钥、runtime 登录或应用设置，不依赖 AI Core、agent、农场协议和应用。根目录 lint 检查这个依赖方向。

| 子路径 | 对外约定 |
| --- | --- |
| `./deepseek/models` | DeepSeek 模型目录、能力和单价；不选择调用者的模型 |
| `./deepseek/request`、`./deepseek/response` | 窄的 DeepSeek 输入/增量契约、请求编码、SSE 分帧、usage/finish reason 解码；不接收 agent 消息类型 |
| `./deepseek/server` | `deepseekModel` 显式接收 model/baseUrl/key，经调用者的 Effect HttpClient 请求；无重试、环境回退和第二网络实现 |
| `./transcription` | Effect 作用域内的 `TranscriptionModelV4` 工厂，使用 `@ai-sdk/provider@4.0.36`；显式接收 endpoint/model/key/格式，无重试或 URL 下载 |
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
| `./moss/models` | 显式凭据查询 MOSS 账号模型目录；固定官方地址、不跟重定向、不重试，15 秒覆盖响应体，限制 1 MiB / 1000 条；只返回 ID 与归属，不猜能力 |
| `./agora/server` | 声网 SDK 客户端、RTC token 和协议错误 |
| `./agora/captions` | 声网字幕包解码与分片；浏览器可用 |

DeepSeek 保留代理返回的 reasoning 字段、choice usage、迟到的工具 ID 和拒绝细节。它是单一的专有适配器，不是通用语言 SDK；AI 层负责 agent 历史重放和消息折叠。为什么不直接换官方适配器，见 [模型边界](docs/subsystems/brain.md#模型边界)。

转写保留 `response_format=json`、`dictation.<format>`、六种格式与 120 秒请求头超时；响应体保留独立的失败通道。作用域内的 FiberSet 将 Core 的 Promise 调用接到调用者的 Effect 服务，测试时钟和取消可到达 HTTP 客户端。默认 OpenAI 适配器的 verbose 格式不是这个接口的契约，因此这里实现上游模型接口。结果保留响应头、原始正文和 usage；缺失的时长、语言和时间戳不猜。

生图协议 `src/moss/image.ts` 接受显式 Key 与文生图或布局输入，固定官方端点，返回单张图片 URL 和用量，不下载文件。请求及响应体共用 900 秒上限，JSON 响应限制 1 MiB；不跟随重定向、不重试。错误区分未提交、明确拒绝和结果未知，只有白名单错误码能跨出边界。任务和本地资产的接入见[生图任务](docs/subsystems/media.md)；调用者必须持久化结果 URL 后独立下载，不能因下载失败重新提交生成。

媒体理解协议只向固定的 `/v1/responses` 提交一次；最多五图或一个视频，支持 file ID 或 HTTPS URL，不支持内联 Base64、流式或异步提交。模型输出 `incomplete` 时仍保留正文，并明确其状态。180 秒覆盖请求与响应体，响应最多 1 MiB；本地指令上限 64000 个 Unicode 码点，规范化 URL 上限 8192 字符，不把这些保护上限称为厂商限制。文件协议 `moss/files.ts` 接受不超过 512 MB 的非空 Blob（可由文件支持，不转成 ArrayBuffer 或 Base64），由 HTTP 客户端生成 multipart boundary；300 秒覆盖请求和响应体，响应最多 1 MiB。文件查询与删除核对回执 ID，上传核对字节数和用途；未知状态原样保留，不推断就绪。路径参数不能跳出文件端点。删除是显式操作，超时与取消可能已留下远端文件，不能假装已经清理。

服务端的用途绑定、输入存储、任务和用户／助手授权由 [Media](docs/subsystems/media.md) 管理，本包不承接上传许可或文件寿命。

单人 TTS 只向固定 `/v1/audio/speech` 提交一次，显式传 Key、模型、文字、voice ID 和格式。Flash／Pro 稳定 ID 与官方快照共用目录；Pro 不接受 language 或 pause 标签，Flash 的 language 使用完整英文名称。文本本地上限 10000 个 Unicode 码点，期望时长本地保护上限 3600 秒，不把这些上限称为官方能力保证。同步强制 `delivery_method=url`、`stream=false`，返回经校验的格式、MIME、HTTPS URL 与厂商用量；异步仅返回 task ID。300 秒覆盖提交和响应体，JSON 最多 1 MiB，不重试、不跟随重定向。缺失的采样率、用量和时长不猜；PCM 流式由独立的 `speech-stream` 请求 SSE，产品的落盘、播放与恢复见 [Media](docs/subsystems/media.md)。

音频任务查询与音色分页只读一次，30 秒覆盖响应体，JSON 最多 1 MiB。任务 ID 不能跳出固定路径，回执 ID、更新时间、格式/MIME 和转写片段起止范围均校验；FAILED 与查询失败分开。音色每页最多 150 条，offset 和 after 互斥，保留不透明游标与空名称，不从列表推断模型兼容性或音色就绪状态。配置绑定与 owner-only 音色目录接口见 [AI 服务](docs/subsystems/provider.md)；克隆样本的授权、账号隔离与生命周期见 [Media](docs/subsystems/media.md)。

浏览器只导入纯协议子路径，不导入服务端工厂。`ask_orchestrator`、页面中继、设置到厂商配置的组装及 RTC 设备由应用负责。实时内核的保留边界见 [语音](docs/subsystems/voice.md#为什么这样)。

检查：`vp run --filter @vibevalley/provider test`；参与 `packages:build`、`server:check` 和 `effect:check`。服务端 voice 测试检查经 Core 的真实转写接线和声网通话生命周期。
