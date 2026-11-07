# packages/provider

`@vibevalley/provider` 管厂商协议和显式连接，不读环境密钥、runtime 登录或应用设置，不依赖 AI Core、agent、农场协议和应用。根目录 lint 检查这个依赖方向。

| 子路径 | 对外约定 |
| --- | --- |
| `./deepseek/models` | DeepSeek 模型目录、能力和单价；不选择调用者的模型 |
| `./deepseek/request`、`./deepseek/response` | 窄的 DeepSeek 输入/增量契约、请求编码、SSE 分帧、usage/finish reason 解码；不接收 agent 消息类型 |
| `./deepseek/server` | `deepseekModel` 显式接收 model/baseUrl/key，经调用者的 Effect HttpClient 请求；无重试、环境回退和第二网络实现 |
| `./transcription` | Effect 作用域内的 `TranscriptionModelV4` 工厂，使用 `@ai-sdk/provider@4.0.36`；显式接收 endpoint/model/key/格式，无重试或 URL 下载 |
| `./moss` | MOSS 帧 Schema、PCM/tagged-v1 编码；浏览器可用 |
| `./moss/server` | MOSS 显式鉴权连接和握手 |
| `./agora/server` | 声网 SDK 客户端、RTC token 和协议错误 |
| `./agora/captions` | 声网字幕包解码与分片；浏览器可用 |

DeepSeek 保留代理返回的 reasoning 字段、choice usage、迟到的工具 ID 和拒绝细节。它是单一的专有适配器，不是通用语言 SDK；AI 层负责 agent 历史重放和消息折叠。为什么不直接换官方适配器，见 [模型边界](docs/subsystems/brain.md#模型边界)。

转写保留 `response_format=json`、`dictation.<format>`、六种格式与 120 秒请求头超时；响应体保留独立的失败通道。作用域内的 FiberSet 将 Core 的 Promise 调用接到调用者的 Effect 服务，测试时钟和取消可到达 HTTP 客户端。默认 OpenAI 适配器的 verbose 格式不是这个接口的契约，因此这里实现上游模型接口。结果保留响应头、原始正文和 usage；缺失的时长、语言和时间戳不猜。

浏览器只导入纯协议子路径，不导入服务端工厂。`ask_orchestrator`、页面中继、设置到厂商配置的组装及 RTC 设备由应用负责。实时内核的保留边界见 [语音](docs/subsystems/voice.md#为什么这样)。

检查：`vp run --filter @vibevalley/provider test`；参与 `packages:build`、`server:check` 和 `effect:check`。AI 的黄金数据继续检查完整请求与响应；服务端 voice 测试检查经 Core 的真实转写接线和声网通话生命周期。
