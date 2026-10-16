# 语音：和管家说话（Agora ConvoAI）

按麦克风就能和管家语音对话，说的活会派到农场上。识别和合成是 Agora 的，「想」有两种：
- **农场的管家**（`vibevalley`）：田头上那个管家本人接电话，看得到地里、自己派活，经「语音线路」接到声网（见下）。
- **别的大模型**（声网托管、DeepSeek、自己的接口）：出声回答的是一个看不到地里的语音管家；它听到的一句话，客户端还交给农场的管家去派活（见「客户端」）。

为什么这样接、放弃了什么，见 [voice-through-agora-quickstart](../.agents/notes/implemented/feature/2026-10-10-voice-through-agora-quickstart.md) 和 [voice-through-our-manager](../.agents/notes/implemented/feature/2026-10-10-voice-through-our-manager.md)。

服务端照官方示例 `agent-quickstart-nextjs`（在仓库外的 `~/orca/projects/agent-quickstart-nextjs`）写，用 Agora 的 Go SDK（`agentkit`、`rtctokenbuilder2`）；客户端是 Flutter（Agora 的 Flutter SDK）。Agora 项目绑定在仓库根目录的 `.agora/project.json`（这台机器的，没有密钥，不进仓库）。

## 和官方示例的对应

| 官方示例 | VibeValley | 改了什么 |
|---|---|---|
| `app/api/generate-agora-token/route.ts` | `server/internal/channels/voice_agora.go`（`Session`、`Renew`；签名在 `server/pkg/agora` 的 `Token`） | 同样用 `BuildTokenWithRtm` 签一个 RTC + RTM 通用的令牌，一小时过期；频道名改成 `vibevalley-…`；凭据缺了就返回带原因的 `VoiceUnavailable`，服务端照常 |
| `app/api/invite-agent/route.ts` | `channels/voice_agora.go`（`Start`，请求由 `voiceAgentFor` 交给 `pkg/agora` 的 `NewAgent` 拼） | 人设换成农场管家；语言改中文：识别用 ARES `zh-CN`，大模型用托管的 `gpt-4.1-mini`，语音用 MiniMax `Chinese (Mandarin)_Gentle_Youth`；这些都能在声音页（`/voice`）改，见下面「配置」 |
| `app/api/stop-conversation/route.ts` | `channels/voice_agora.go`（`Stop`；判断在 `pkg/agora` 的 `AlreadyStopping`） | 照搬「已经在关就当成功」的判断，并放宽：这个提示有时出现在 `reason` 字段里（实测是 400 ErrConflict） |
| `lib/agora.ts`（`DEFAULT_AGENT_UID`） | Go 的 `protocol.VoiceAgentUID` | 服务端请语音管家进频道时用它 |
| `types/conversation.ts` | `server/internal/protocol/shapes.go`、`api.go` | 接口定义成 `Handlers` 的一部分，Dart 的类型由它生成 |
| `components/ConversationComponent.tsx` | `app/lib/voice/voice.dart`（`VoiceCall`） | 见下面「客户端」 |
| `lib/conversation.ts`（`normalizeTranscript`） | `app/lib/voice/captions.dart` | 每次收到的都是一轮到目前为止的整段话，按轮次替换，不重复追加 |

## 接口

`POST /api/voice/session`（令牌、频道、uid）、`/api/voice/renew`（续期）、`/api/voice/agent`（请语音管家进频道，`captions` 选字幕走 RTM 还是 RTC 的 data stream）、`/api/voice/agent/stop`（请它离开）。形状在 `server/internal/protocol/shapes.go`（`Voice…`）；服务端是 `internal/channels/voice_agora.go` 的 `Voice`。

## 客户端

**Flutter**（`app/lib/voice/`）：从服务端取令牌，请语音管家进频道时要 `captions: 'datastream'`，再用 Agora 的 Flutter SDK 以服务端给的数字 uid 加入（直播频道、`audioScenarioAiClient`，加一组 AI 回声消除和降噪的参数）。Agora 的 Flutter RTM 只有 Android 和 iOS，所以字幕、打断和语音管家自己的状态都走 RTC 的 data stream：服务端据此设 `data_channel` 并关掉 `enable_rtm`。每条消息切成 `id|第几块|共几块|base64`，`captions.dart` 拼好再解。令牌快过期时（`onTokenPrivilegeWillExpire`）向 `/api/voice/renew` 要一个新的换上。麦克风一直开着，静音是一个按钮。只链语音要的 Agora 组件（`tool/agora-voice-only.sh`，[flutter](../app/README.md#跑和打包)）。

语音接通时：

- 管家的话和你说的话出现在田头窗口和管家头上的气泡里。它们只在客户端上，不写进田头的记录，帮工看不到；你说的活由管家派出去，派活消息照常在田头上。
- 语音管家的状态（在听、在想、在说）驱动农舍门口管家的动作；狗会醒着。
- 你说完一句话，这句话交给农场派活（`POST /api/dispatch`，带上帮工栏选的帮工；管家只派活不回话，回话由语音管家来）。客户端在字幕定稿时转交（`lib/voice/captions.dart` 的 `onHeard`），每一轮一次。

## 凭据

Agora 的 App ID 和 App Certificate 在首页的「设置」或声音页里填，存在 `$VIBEVALLEY_HOME/settings.json`，存了马上能用（[server.md](server.md)「设置」）。也可以放进环境变量 `AGORA_APP_ID`、`AGORA_APP_CERTIFICATE`：写进 `$VIBEVALLEY_HOME/.env`，或者给 `go run ./cmd/vibevalley --env-file` 一个文件（`agora project env write <文件>` 能写出来）；设置里存的优先。这些文件里是密钥，不进仓库。

## 配置（`/voice`、`/manager/voice`）

语音设置分两处改，存在同一处：`settings.json` 的 `voice`，只存和默认不一样的；下一通电话生效（`Voice` 每次开始时现取）。工作台左栏的「声音」（Flutter 的 `app/lib/desk/voice/voice_page.dart`）配**线路**：凭据、怎么听、用哪个大模型。管家页的「声音」页签（`/manager/voice`，同一张表的另一半）配**电话上的管家**：人设、开场白、音色。每处的「恢复默认」只动自己那几项（[理由](../.agents/notes/implemented/feature/2026-10-13-agent-pages-memory-and-voice.md)）。

| 在哪 | 卡片 | 能改什么 | 默认 |
|---|---|---|---|
| 声音 | 凭据 | App ID、App Certificate（和首页「设置」是同一份）；区域（Agora 接口的 `Area`：美国、欧洲、亚太、中国大陆） | 环境变量 `AGORA_APP_ID`、`AGORA_APP_CERTIFICATE`；美国 |
| 声音 | 听 | 识别用谁；语言（识别和断句的语言）；停顿多久算说完；说多久能打断他；没人时多久离开 | 声网 ARES、`zh-CN`、480 毫秒、160 毫秒、30 秒 |
| 声音 | 想 | 大模型用谁：农场的管家，或别的大模型 | 声网托管的 `gpt-4.1-mini`（或 `VIBEVALLEY_VOICE_MODEL`） |
| 管家页 | 开口 | 人设；开场白；出错时说的话 | 农场管家的人设 |
| 管家页 | 说 | 合成用谁和音色 | MiniMax `speech_2_6_turbo`、`Chinese (Mandarin)_Gentle_Youth`（或 `VIBEVALLEY_VOICE_ID`） |

每一段可以用声网托管的（不用别的 key），也可以换成自己的服务：

| 段 | 能选 | 要什么 |
|---|---|---|
| 识别 | 声网 ARES；Deepgram（`nova-2`、`nova-3`，声网托管）；微软 Azure | 微软要区域和 key |
| 大模型 | 农场的管家（经语音线路，见下）；声网托管的 GPT（`gpt-4o-mini`、`gpt-4.1-mini`、`gpt-5-nano`、`gpt-5-mini`）；DeepSeek；任何 OpenAI 兼容的接口 | DeepSeek 用农场的 DeepSeek key（首页「设置」的那个，没有就用 pi 的），默认 `deepseek-chat`；自己的接口要 chat completions 的完整地址、模型名和 key |
| 合成 | MiniMax（声网托管，音色从列表里选或填系统音色 id；列表里每个音色旁边的 ▶ 播一段样音）；OpenAI `tts-1`（声网托管，六个音色）；微软 Azure | 微软要区域、音色名（比如 `zh-CN-XiaoxiaoNeural`）和 key |

**样音**（`app/assets/voice-samples/`）：列表里每个 MiniMax 音色念一遍默认的开场白，是用 MiniMax 自己的合成接口生成好、放进仓库的 mp3。试听不连网、不花钱，也不打电话。自己填的音色 id 没有样音；改了开场白，样音念的还是默认那句。

自己服务的 key 和农场的钥匙一样存在 `settings.json`（`asrKey`、`llmKey`、`ttsKey`，每段一个），页面只看到最后四个字。缺 key 时开始通话会直接说缺哪个、去哪填，不去问 Agora（`channels/voice_agora.go` 的 `voiceVendorsFor`）。

字段和可选的服务在 `server/internal/protocol/shapes.go`（`VoiceSettings`、`VoiceAsr`、`VoiceLlm`、`VoiceTts`）；默认和范围在 Go 的 `internal/protocol/voice.go`（`DefaultVoice`、`VoiceProblem`），Flutter 的 `lib/desk/voice/voice_rules.dart` 是它的移植。「恢复默认」把这一处的几项回到默认（含环境变量给的）；两处都回到默认时，存下去就是把 `voice` 从文件里删掉。

## 语音线路（「想」选农场的管家时）

`server/internal/channels/voice_line.go`：声网的对话式 AI 按 OpenAI Chat Completions 协议来问管家，管家回答的字一边生成一边以 SSE 流回去念。
- **只有这一个接口对外**：服务端另开一个监听（`VIBEVALLEY_VOICE_LINE_PORT`，默认 8788，也只听 127.0.0.1），上面只有 `POST /llm/<通话>/chat/completions`，农场的其他接口都不在这里。端口被占时只记一行日志，农场照常，这条线路接不通。
- **隧道**：设了 `VIBEVALLEY_VOICE_LINE_URL`（你自己的隧道的公网地址），就把它给声网；没设时，第一通电话开一个 cloudflared 临时隧道（要先 `brew install cloudflared`）。新隧道的地址要过一会儿才通（实测约 25 秒），所以第一通电话会等到它能应答（最多 60 秒）；最后一通电话挂了 10 分钟后关掉，这期间再打不用重新等。
- **每通电话一把钥匙**：开始通话时生成，声网的请求要带 `Authorization: Bearer <钥匙>`，不对返回 401；挂了电话钥匙作废。
- **只取最新的一句**：声网发来的 `messages` 只取最后一条主人说的话，交给管家（`Foreman.Call`）时注明是电话里说的、回答要口语、一两句；对话历史以管家自己的会话为准。管家这一轮说的每段话都念出来（调工具前的「我看一下」也是），这一轮结束就收尾。说的话照样进田头。
- **插话**：声网打断时丢掉正在念的请求，这一轮剩下的字不再送出；同一通电话的新一句会结束上一句的流。
- 服务端日志记从请求进来到第一段字送出的毫秒数。
- 这时转话的路（`/api/dispatch`）不再交给管家，免得一句话被处理两次；声音页里的人设也不用。
