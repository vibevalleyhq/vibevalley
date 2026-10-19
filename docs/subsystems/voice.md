# 语音

主人用嘴和农场说话，分两条路：**电话**（`voice.Service` 的通话）按田头窗口里的麦克风和管家实时对话，传输、识别、断句、打断和合成都由 Agora 的对话式 AI（ConvoAI）做；**听写**按输入框旁的录音按钮说一段，转成输入框里的字，不经过 Agora。电话里「谁接电话」有两种：管家自己接（经「语音线路」），或一个快嘴模型先答、管家旁听派活。两种下电话里说的话都进田头的主频道。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 电话：签 RTC 令牌、请语音管家进出频道、续签、挂断 | 管家怎么想、怎么派活，`Call`、`Heard`、`Answerer` 的提示（[管家](docs/subsystems/manager.md)） |
| 语音线路：单独的回环监听、每通电话一把钥匙、隧道 | OpenAI `chat/completions` 的协议本身（`internal/agent/brain/openai.go`，[管家](docs/subsystems/manager.md)「OpenAI 的协议」） |
| 两种字幕的接受和分流（按通话建立时的模式） | 字幕怎么留在田头、不叫醒谁（`channel` 的 `Spoken`，[田头](docs/subsystems/channel.md)） |
| 听写：把录音转给主人填的转写地址 | 设置的存取、优先级、钥匙只给提示（`internal/setting`，[设置](docs/subsystems/setting.md)） |
| 语音设置的形状、默认值和保存前的检查 | 「连接到本机」放哪些接口（[连接到本机](docs/subsystems/lan.md)）；语音接通在账本上记一笔（`game`） |
| 客户端的通话（`VoiceCall`）、字幕拼块、听写按钮 | 田头窗口和手机怎么画通话（`farm/chat_voice.dart`、`phone/`） |

## 在哪

- 服务端 `server/internal/voice`（`voice.Service`，`Workspace` 上的 `Voice`；[包的约定](server/internal/voice/README.md)）：`rtc.go` RTC 授予（签发、认领、续签、撤销）；`agora.go` 通话（`Start`、`Stop`、`Heard`、`HeardCurrent`、`Said`）和把语音设置翻成 Agora 的 vendors（`voiceVendorsFor`、`voiceAgentConfig`）；`line.go` 语音线路；`dictate.go` 听写。
- `server/pkg/agora`：令牌（`Token`、`TokenSeconds`）、频道和 uid（`NewChannel`、`NewUID`）、请 agent 进出（`Client.Start`、`Client.Stop`）、快嘴模型的参数（`SpeakingLLM`）。
- 形状和规则：`protocol/shapes.go` 的 `VoiceSettings`（`VoiceASR`、`VoiceAnswer`、`VoiceTTS` 三个联合）、`SettingsUpdateVoice`、`AgoraGrant`、`Dictation`；数的范围是 `shapes.go` 开头的 `VoiceSilenceMsMin` 等常量；默认在 `protocol/voice.go`（`DefaultVoice`、`VoiceAgentUID`）。保存前的检查和只存差异在 `setting/voice_rules.go`（`voiceProblem`、`voiceSettingsOver`、`voiceOverrides`）。
- 接口：`voice.session`、`voice.renew`、`voice.start`、`voice.stop`、`voice.heard`、`voice.said`、`voice.dictate`，旧客户端的 `manager.hear`（[capabilities.md](docs/reference/capabilities.md)）；都带 `remote`，经「连接到本机」连进来的手机也能打电话、听写。语音线路的 `POST /llm/<通话>/chat/completions` 在单独的监听上。
- 不存表：授予和通话只在进程里；设置在 `$VIBEVALLEY_HOME/settings.json` 的 `voice`、`dictation`、`asrKey`、`llmKey`、`ttsKey`、`dictationKey`、`agoraAppId`、`agoraAppCertificate`。
- 配置：`agora.app_id`、`agora.app_certificate`（或环境变量 `AGORA_APP_ID`、`AGORA_APP_CERTIFICATE`），`voice.model`、`voice.id`（默认的托管模型和 MiniMax 音色），`voice.line.port`（默认 8788，0 是空闲端口）、`voice.line.url`（`base/config.go`）。
- 客户端：`app/lib/voice/`（`voice.dart` 的 `VoiceCall`，`captions.dart` 的 `LiveCaptions`，`dictation.dart` 的 `Dictation`），由 `data/voice.dart` 按农场作用域提供；按钮 `app/lib/chat/dictation_button.dart`（`DictationButton`）；设置页 `app/lib/workbench/voice/`（`voice_page.dart` 的 `VoiceSettingsForm`），路由 `/settings/voice` 和管家页的 `/manager/voice`；样音 `app/assets/voice-samples/`；只链语音要的 Agora 组件 `app/tool/agora-voice-only.sh`。

## 模型和不变量

- **Agora 只在两处**：服务端 `github.com/AgoraIO/` 只在 `server/pkg/agora` 和 `server/internal/voice/agora.go`；客户端 `package:agora_rtc_engine` 只在 `app/lib/voice/`（`scripts/app-imports.ts` 的 `VENDOR`）。别处看到的是 `voice.Service` 的 `Session`、`Renew`、`Start`、`Stop` 和 `VoiceCall`。
- **一份授予是一组 `channel + uid`**：`Session` 生成频道（`vibevalley` 前缀）和数字 uid，签一个 RTC + RTM 通用的令牌（`TokenSeconds` = 3600 秒），同时把这组身份和签发时的 Agora 凭据快照存进授予。`Renew` 和 `Start` 只认这份授予，不重读当前凭据：中途改 App ID 只影响下一通电话。
- **授予的期限就是令牌的期限**：没启动的授予与令牌同时过期，续签把两者一起延长；过期的在下一次请求时清掉，服务停止时全部清空。未知、过期或已撤销的 `channel + uid` 续签和启动都回 `VoiceUnavailable`（「这通电话的语音凭据已经失效，请重新接通」），客户端重新取 `/session`。
- **一份授予只有一个启动者**：`Start` 原子认领（`starting`），重复启动回「这通电话已经在接通」；启动失败撤销授予；成功后授予归通话，直到 `Stop`。
- **一通电话记下建立时的决定**：`voiceCall` 存它用的 Agora client、语音线路的释放函数、是不是快嘴（`quick`）和开场白。之后改「谁接电话」、区域、凭据都不改这通电话：字幕怎么分流、停止请求发到哪个区域都按建立时的。
- **挂断一开始，字幕资格就终止**：`Stop` 先删授予、把通话标成 `ending`，此后 `Heard`、`Said` 回 `VoiceAgentFailed`（「这通电话已经挂了」）；声网停止失败时保留原 client 供重试，但不再接字幕。
- **电话里的每句话由服务端记进田头**，带 `spoken`，不叫醒任何人：主人的话快嘴模式下由 `Manager.Heard` 记，管家模式下由 `Manager.Call` 记；管家的回答照常进田头；快嘴的回答由客户端交 `/voice/agent/said`，只在快嘴模式、通话没挂时记，开场白不记。
- **一句话只处理一次**：管家模式下 `/agent/heard` 收下但不转给管家（语音线路已经交过）；`heard` 带 `sendKey`，同一个键再交是已经听过的那句。
- **语音线路只有一个接口对外**：监听只听 127.0.0.1，只有 `POST /llm/<通话>/chat/completions`；请求要带这通电话的 `Authorization: Bearer <钥匙>`，钥匙随挂断作废。别的路径 404，没钥匙或钥匙不对 401。
- **一段听写拥有它的目标**：开始时绑定起始输入框、录音器、临时文件和取消信号；在另一个输入框按停止不改变文字去向。输入框销毁或农场切换时取消这一段；迟到的权限、录音启动和转写结果不能再打开麦克风或写进别的草稿。
- **语音设置一份，只存差异**：`settings.json` 的 `voice` 只存和默认不一样的字段（页面发整份，服务端去掉和默认一样的），`{}` 就是恢复默认、从文件里删掉。默认是 `DefaultVoice` 再叠配置的 `voice.model`、`voice.id`。每通电话开始时现取（`Settings.VoiceConfig()`，设置和三段的 key 从同一版读出），存了下一通生效。

## 怎么走

**接通**（客户端 `VoiceCall.start`）：

1. 移动端先要麦克风权限。`POST /api/v1/voice/session` 拿 `AgoraGrant`（`appId`、`channel`、`uid`、`token`）；没凭据回 `VoiceUnavailable`（「还没有 Agora 的凭据」），别的照常。
2. 用 `appId` 初始化 RTC 引擎、加入频道、发布麦克风。
3. `POST /api/v1/voice/agent`（`channel`、`uid`）。服务端认领授予、按当前语音设置建 vendors：
   - 「谁接电话」是管家（`VoiceAnswerManager`）时先开语音线路（`voiceLine.Open`），拿到这通电话的地址和钥匙，作为 OpenAI 兼容的大模型交给 Agora，模型名 `vibevalley-manager`（`protocol.ManagerModel`）；开不了回 `VoiceUnavailable`（「管家的语音线路接不通」）。
   - 快嘴：Agora 托管的模型、DeepSeek（用农场的 DeepSeek key，`https://api.deepseek.com/chat/completions`）或自己的 OpenAI 兼容接口（`llmKey`）。参数固定：最多 15 轮历史、`max_tokens` 512、`temperature` 0.7、`top_p` 0.95，带开场白和出错时说的话。
   - 要 key 的（微软识别 `asrKey`、自己的大模型 `llmKey`、微软合成 `ttsKey`）缺 key 就回 `VoiceUnavailable`，说缺哪个、在哪一格填；agentkit 拒绝某个配置会 panic，`voiceVendorsFor` 接住，当作「语音设置用不了」。
   - 断句和打断：VAD，`SilenceMs`（默认 480）、`InterruptMs`（默认 160），`IdleSeconds`（默认 30）没人就离开；字幕走 RTC 的 data stream（Agora 的 Flutter RTM 只有移动端）；语音管家的 uid 固定是 `VoiceAgentUID`，客户端靠它分开管家的声音和字幕。
   - 请 Agora 启动（HTTP 超时 25 秒）。失败回 `VoiceAgentFailed`，撤销授予、关线路。启动返回时服务已经停下或授予已被撤销，用 5 秒的时限请它离开，回 `VoiceUnavailable`。
   - 成功：记下通话，回 `agentId`；`core.Did(OwnerTalked)` 让账本记一笔语音。
4. 令牌快过期时（`onTokenPrivilegeWillExpire`）`POST /api/v1/voice/renew` 换同一组 `channel + uid` 的新令牌；失败在通话上显示原因。

**字幕**：客户端从 data stream 收分块的消息，`LiveCaptions` 拼齐一轮再解，只留最近几轮。

- 主人的一句定稿时，连同 `agentId`、档案选择和 `sendKey` 交 `POST /api/v1/voice/agent/heard`。快嘴模式下服务端把农场设成开着（`core.Open`）、交给 `Manager.Heard`：记成主人在主频道的发言，提示管家「语音那边已经回答了」，派了活才说一句派给了谁。管家模式下收下不转。
- 快嘴的一轮说完或被打断时（`turn_status` 不为 0），客户端把说到的部分交 `POST /api/v1/voice/agent/said`，服务端经 `chat.Spoken` 记成管家的话。
- `/voice/agent` 返回前收到的字幕，客户端暂存到拿到 `agentId` 再发；取消通话清掉它们。
- 旧客户端的 `POST /api/v1/manager/hear` 没有 `agentId`，由 `HeardCurrent` 适配：只有一通没在挂的电话时绑定到它；一通都没有回「没有正在接通的电话」，有几通回「请升级客户端后重试」。

**管家接电话**（`line.go`）：

1. 监听开在 `voice.line.port`（默认 8788，只听 127.0.0.1）；端口被占时只记日志，农场照常，打给管家的电话回原因。
2. 隧道：设了 `voice.line.url` 就用它（去掉结尾的 `/`）；没设时第一通电话开 cloudflared 临时隧道（`cloudflared tunnel --url`），30 秒内给不出 `trycloudflare.com` 地址就失败，没装就提示 `brew install cloudflared` 或设 `voice.line.url`；拿到地址后每 2 秒探一次，最多 60 秒，线路回 401 算通了，到时还不通也接着打，只记日志。最后一通挂了 10 分钟后关隧道，其间再打就复用。
3. 每通电话一个随机的通话 id 和钥匙；Agora 每说完一句就来一个请求。协议由 `brain.ChatCompletions` 处理：只取 `messages` 里最后一条 `user`，交给 `Manager.Call`（先 `Spoken` 记进田头，再带「电话里说的、要口语」的提示问管家），管家的字边长边以 SSE 流回去念。没有主人的话时回一句「嗯？我没听清，你再说一遍？」。
4. Agora 在主人插话时挂掉请求：请求的 context 结束，就不再送字；同一通电话的新一句结束上一句的流；管家这一轮照常跑完。

**挂断**（`VoiceCall.end` → `POST /api/v1/voice/agent/stop`）：终止字幕资格、撤销授予，用建立时的 client 请 Agora 离开（它已经在走、回 404 也算成功），释放语音线路的钥匙。失败回 `VoiceAgentFailed`，通话留着可以再停。不认识的 `agentId` 用当前凭据和区域去停。服务停止时清空授予、关线路和隧道。

**听写**：

1. 点一下按钮，`Dictation` 绑定这个输入框开始录（16 kHz 单声道 WAV，`record` 包）；再点一下停。
2. 录音 base64 交 `POST /api/v1/voice/dictate`（`format`: `wav`）。服务端认 `wav`、`m4a`、`mp3`、`webm`、`ogg`、`flac`；不认识的格式、空的、不是 base64、超过 25 MB 回 `Refused`。
3. 原样转给 `POST {url}/audio/transcriptions`（multipart，带 `model`、`response_format: json`，有 `dictationKey` 就带 `Authorization: Bearer`），不加提示、不改声音，时限 2 分钟（本机模型第一次要加载）。没配地址、地址不对、连不上、对方回非 2xx（带对方的错误，留头 200 字）、回的不是转写格式，都回 `VoiceUnavailable` 和原因。
4. 回来的 `text` 插进输入框的光标处（没有光标就放末尾，只在拉丁词之间补空格），主人看过再发；发出去是一条普通的消息。临时录音随这一段清理。

**改设置**：「设置」的「声音」（`/settings/voice`）配线路：凭据和区域、识别、语言、断句、打断、没人时多久离开、谁接电话（`answer`），和「听写」的地址、模型、key。管家页的「声音」（`/manager/voice`）配电话上的管家：人设（只对快嘴有用）、开场白、出错时说的话、音色。两处是同一个 `VoiceSettingsForm`，按 `VoicePart`（`line`、`agent`）分；每处只把自己那几项叠在当前最新的设置上存，「恢复默认」只动自己那几项，两页不会互相覆盖。页面一边改一边问 `POST /api/v1/settings/check`，显示的就是保存时会被拒的理由。自己服务的 key 页面只看到最后四个字。MiniMax 音色旁边的试听播的是仓库里预先生成的样音，不连网。

听写的地址有两种用法：本机开着 [speech-swift](https://github.com/soniqo/speech-swift) 的 `speech-server`（`brew install speech`），填 `http://127.0.0.1:8080/v1`、模型 `qwen3`、key 空着，声音不出这台电脑；云上如 OpenAI 填 `https://api.openai.com/v1`、`gpt-4o-mini-transcribe` 和 key，声音送到那一家。

## 和谁打交道

- **管家（`manager`）**：快嘴模式的主人字幕经 `Heard(text, agent, sendKey)`；语音线路的每句经 `Call(ctx, text)`，回一个字的 channel。`Call` 和本机 `/v1/chat/completions` 的 `Answerer` 共用一个回答的流，同一时间只流一个。
- **田头（`channel`）**：快嘴的回答经 `Spoken(ManagerAgent, text, "")`；主人的话和管家的回答由管家那边经 `Spoken`、`ManagerSays` 记。带 `spoken` 的消息 `chatAudience` 不投给任何人。
- **设置（`setting`）**：`Agora()`（每次现取，首页存的凭据不用重启）、`VoiceConfig()`、`Voice()`、`Dictation()`。
- **核心（`core`）**：`Did(OwnerTalked)`（账本的语音时刻）、`Open()`。
- **配置（`base.Config`）**：语音线路的端口和隧道地址。
- **客户端**：`VoiceCall` 只经 `api.voice.*` 和服务端说话；田头窗口、HUD、手机读它的阶段、字幕、两条音量和管家的状态，不持有 RTC 资源。

## 为什么这样

- **实时通话用 Agora 的 ConvoAI，照官方示例搬。** RTC 传输、回声消除、断句、插话打断和把识别、想、合成串成实时链路是难点，自己做成本远超需要；放弃了自己接识别和合成。Agora 的 SDK 参数多、变得快，照能跑通的 `agent-quickstart-nextjs`（客户端照声网的 Flutter quickstart）搬，比凭记忆写快。
- **只把「想」换成我们的管家，经一个只有一个接口的监听。** 声网能接 OpenAI 兼容的自定义大模型，所以识别、断句、合成照用，管家在电话里就是田头上那个，看得到地里、自己派活。放弃了用隧道转发整个服务端：帮工能执行任意命令，派活、改配置的接口都会上公网。放弃了给托管模型塞农场上下文（它调不了我们的工具）和用 Agora 的 think 接口塞指令（措辞不进管家自己的历史）。代价是本机多一个对外口子，只认带钥匙的请求。
- **协议只取最后一句，历史以管家的会话为准。** 照 OpenAI 的语义读全部 `messages`，管家的会话和 Agora 那边的历史会是两份：插话时没念完的字、田头里说的话 Agora 都不知道。协议放在 `internal/agent/brain`，不留在 `voice`：主服务的本机接口也用它。
- **Agora 是供应商，不是概念，不开 `internal/agora`。** 照连接器的做法，封装在 `pkg/agora`，翻译设置的适配在 `voice/agora.go`（它要读 `protocol` 的设置，搬进 `pkg/agora` 就得再写一份选项类型）。客户端 `VoiceCall` 直接持有 `RtcEngine`，不拆出只有一个实现的接口；也不抽 `Transport`、`TTS` 接口，第二家真要接时再抽，能换平台靠 OpenAI 协议。
- **听写不走 Agora，转给主人填的 OpenAI 兼容地址。** 走 Agora 要开一通按分钟计费的会话、请一个 agent 进频道，能选的识别也接不上中文准的国内厂商；听写不需要断句和打断。经服务端转一手是为了 key 留在服务端、「连接到本机」进来的手机也能用 Mac 上的本地模型。放弃了服务端打包并拉起本机识别（要管约 1 GB 的模型和它的生命周期）和用 cgo 链 Swift（模型一崩农场跟着挂）。字去输入框、不叫醒管家；放弃了让管家整理听写：每段草稿都会进管家的会话、叫醒它一轮。
- **RTC 授予拥有这通电话的应用身份。** 三个请求各读一次当前凭据时，拿令牌后改 App ID 会让启动或续签指向另一个应用，而已经初始化的 RTC 引擎换不了身份。现有的 `channel + uid` 已由服务端生成，足以标识授予，不另加 grant id；没启动的授予用令牌的期限，不另设较短的，免得令牌还有效 `Start` 却拒绝。
- **字幕归这通电话，由 `voice` 分流。** 管家按当前设置决定旁不旁听时，中途改「谁接电话」会让同一通电话的两种字幕按两份规则走；客户端读设置再决定也一样受影响，还重写了服务端的规则。旧的 `manager/hear` 保留成受限的适配：已配对的设备可能还在旧版本。
- **快嘴的回答由客户端上报。** 一轮结束的信号只在客户端的字幕流里；客户端挂得太快会少一条，有意接受，不重试。
- **一段听写拥有目标，不由停止按钮临时给写字回调。** 在每个回调里查页面存活只挡住销毁后的写字，挡不住在另一输入框按停止换掉目标，也管不了还没返回的录音启动。每个输入框各开一个听写器会让两处争用麦克风，所以农场作用域里只有一个 `Dictation`，每段独立管自己的目标。
- **语音设置和钥匙放在同一个 `settings.json`，只存差异，分两处改。** 单独的接口和文件会让页面两个请求、两套「存好了没」；整份存下来，默认的人设改进了，存过一次的人永远停在旧的上。拆成两份存要多一套默认和覆盖的规则；现在只有管家一个人说话，同一份数据按归属在设置页和管家页两处改就够了。页面只放听、想、说里会改的几样，VAD 阈值、前置填充这些留在代码里。加一家服务就是联合里多一个成员：Dart 编译器查声音页的 `switch`，Go 靠测试按生成的成员表查 `voiceVendorsFor`。
- **样音预先生成、放进仓库。** 现场合成要服务端有 MiniMax、OpenAI 的 key，可平时用的是声网托管的合成；借声网录一段要等几秒、花通话时长。列表里的音色是固定的，生成一次最省事；代价是样音念的是默认开场白，OpenAI 和微软的音色没有样音。

## 还没做的

- 帮工各自的音色、田头朗读、直接给帮工打电话：[帮工各自的音色](.agents/notes/proposed/feature/2026-10-13-helper-voices.md)。

## 怎么验证

- `voice/rtc_test.go`（假的 SDK 对端和可控时钟）：`TestRTCGrantKeepsItsApplicationAcrossSettingsChanges`、`TestPendingRTCGrantExpiresWithItsToken`、`TestRTCGrantIsRevokedWhenStartOrStopFails`、`TestRTCGrantHasOneStarterAndCannotOutliveService`。
- `voice/agora_test.go`：`TestVoiceRequestsMatchGolden`（拼出的声网请求对 `testdata/voice-requests.json`）、`TestVoiceVendorsSayWhichKeyIsMissing`、`TestVoiceVendorsKnowEveryVendor`（按 `VoiceASRMembers`、`VoiceAnswerMembers`、`VoiceTTSMembers`）、`TestVoiceSessionsNeedCredentials`、`TestVoiceStartAndStopTheManagerOnHisLine`、`TestVoiceCallOwnsItsCredentialsAndLine`、`TestCallOwnsBothTranscriptDirectionsAcrossSettingsChanges`、`TestV1RelayRequiresOneActiveCall`。
- `voice/line_test.go`：`TestVoiceLineLetsOnlyThisCallsKeyIn`、`TestVoiceLineDroppedRequestStopsItsWords`、`TestVoiceLineOpensAndClosesCalls`、`TestVoiceLineQuickTunnelLingersAfterTheLastCall`、`TestVoiceLineCannotReopenAfterStop`、`TestVoiceLineExpiredTimerCannotCloseReopenedTunnel`、`TestVoiceKeepsWhatAgorasModelSaidOnALiveCall`。
- `voice/agora_boundary_test.go` 的 `TestAgoraStaysBehindTheVoiceAdapter`；客户端由 `bun run app:imports` 守 `agora_rtc_engine`。
- `voice/dictate_test.go`：`TestDictationPassesTheRecordingOn`、`TestDictationSaysWhyTheEndpointFailed`、`TestDictationSettingsAreChecked`。
- `setting`：`setting_test.go` 的 `TestSettingsVoiceKeepsOnlyWhatDiffers`、`TestSettingsVoiceVendorKeysAreHints`；`setting_rules_test.go` 的 `TestVoiceOverrides`；`concurrency_test.go` 的 `TestVoiceConfigReadsProviderAndKeysFromOneRevision`。
- `manager`：`TestManagerDispatchesAndHearsVoiceInChat`、`TestManagerCallStreamsItsWords`、`TestManagerHearsASendKeyOnce`、`input_test.go` 的 `TestNewVoiceCallerDoesNotReceiveOlderChatAnswer`；协议在 `agent/brain/openai_test.go` 的 `TestChatCompletions…`。
- 客户端 `app/test/voice/`：`lifecycle_test.dart`（字幕等 `agentId`、挂断后的迟到字幕、连接中挂断、迟到的语音管家只停一次）、`captions_test.dart`、`heard_test.dart`、`dictation_test.dart`（两个目标交替、权限迟到、录音文件迟到、转写迟到、录音器只释放一次、插在光标处）；`test/chat/chat_test.dart` 的 spoken 只进主频道。
- 真人说话、听到声音要人在 macOS 上亲自打一通（`verify-app`）；没有连真的声网的自动测试。
