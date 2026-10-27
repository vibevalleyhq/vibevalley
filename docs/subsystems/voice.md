# 语音

主人用嘴和农场说话，分两条路：**电话**（`Voice` 的通话）点农场手机里的「管家」和管家实时对话，传输、识别、断句、打断和合成都由 Agora 的对话式 AI（ConvoAI）做；**听写**按输入框旁的录音按钮说一段，转成输入框里的字，不经过 Agora。电话里「谁接电话」有两种：管家自己接（经「语音线路」，默认），或一个快嘴模型先答、管家旁听派活。两种下电话里说的话都进默认频道。

## 管什么，不管什么

| 管 | 不管（谁管） |
|---|---|
| 电话：签 RTC 令牌、请语音管家进出频道、续签、挂断 | 管家怎么想、怎么派活，`answerer`、`heard` 的提示（[管家](docs/subsystems/orchestrator.md)） |
| 语音线路：单独的回环监听、每通电话一把钥匙、隧道 | OpenAI `chat/completions` 的协议本身（`agent/brain/openai.ts`，[管家](docs/subsystems/orchestrator.md)「OpenAI 的协议」） |
| 两种字幕的接受和分流（按通话建立时的模式） | 字幕怎么留在频道、不叫醒谁（`channel` 的 `spoken`，[频道](docs/subsystems/channel.md)） |
| 听写：把录音转给主人填的转写地址 | 设置的存取、优先级、钥匙只给提示（`setting`，[设置](docs/subsystems/setting.md)） |
| 语音设置的形状、默认值和保存前的检查 | 「连接到本机」放哪些接口（[连接到本机](docs/subsystems/lan.md)）；语音接通在账本上记一笔（`game`） |
| 页面的通话（`VoiceCall`）、字幕拼块、听写按钮 | 田头窗口和手机怎么画通话（`apps/web/src/farm/chat`、`farm/phone`） |

## 在哪

- 服务端 `apps/server/src/voice/voice.ts`（`Voice`）：RTC 授予（签发、认领、续签、撤销）、通话（开始、停、`heard`、`said`）、把语音设置翻成声网的 vendors（`vendorsFor`、`agentFor`）、语音线路和隧道、听写。声网的令牌用 npm 的 `agora-token`，请 agent 进出用 `agora-agents`（声网的 ConvoAI SDK）。
- 形状和规则：`shapes.ts` 的 `VoiceSettings`（`VoiceASR`、`VoiceAnswer`、`VoiceTTS` 三个联合）、`SettingsUpdateVoice`、`AgoraGrant`、`Dictation`；数的范围是 `shapes.ts` 的 `voiceSilenceMsMin` 等常量；默认在 `setting/rules.ts`（`defaultVoice`）。保存前的检查和只存差异在 `setting/rules.ts`（`voiceProblem`、`voiceSettingsOver`、`voiceOverrides`）。
- 接口：`voice.session.create`、`voice.session.renew`、`voice.agent.start`、`voice.agent.stop`、`voice.agent.hear`、`voice.agent.say`、`voice.dictate`，没带通话 id 的 `voice.hear`（[capabilities.md](docs/reference/capabilities.md)）；都带 `remote`，经「连接到本机」连进来的设备也能打电话、听写。语音线路的 `POST /llm/<通话>/chat/completions` 在单独的监听上。
- 不存表：授予和通话只在进程里；设置在 `$VIBEVALLEY_HOME/settings.json` 的 `voice`、`dictation`、`asrKey`、`llmKey`、`ttsKey`、`dictationKey`、`agoraAppId`、`agoraAppCertificate`。
- 配置：`agora.app_id`、`agora.app_certificate`（或环境变量 `AGORA_APP_ID`、`AGORA_APP_CERTIFICATE`），`voice.id`（默认的 MiniMax 音色），`voice.line.port`（默认 8788，0 是空闲端口）、`voice.line.url`（`base/config.ts`）。
- 页面：`apps/web/src/features/voice/`（`call.ts` 的 `VoiceCall`、`VoiceCall`、`useCall`，`captions.ts` 的字幕拼块，`dictation.ts` 的录音和 WAV，`DictationButton.tsx` 的听写键，`createCall.ts` 的 `createCall`，各处读同一通电话）；打电话是农场手机的事（点「管家」就拨），田头和工作台的聊天输入框只有听写；设置页 `features/voice/VoiceForm.tsx`（`part` 是 `line` 或 `agent`），路由 `/settings/voice` 和管家页的 `/orchestrator/voice`；样音 `apps/web/public/voice-samples/`。

## 模型和不变量

- **Agora 只在三处**：服务端的 `agora-token`、`agora-agents` 只在 `voice/voice.ts`；页面的 `agora-rtc-sdk-ng` 只在 `src/features/voice/agora.ts`，开始打电话时才动态加载；手机壳的 `react-native-agora` 只在 `apps/mobile/src/rtc.ts`。别处看到的是 `Voice` 的方法、`VoiceCall` 和 `@vibevalley/protocol/host` 的 `Rtc`。
- **一份授予是一组 `channel + uid`**：签发时生成频道（`vibevalley` 前缀）和数字 uid，签一个 RTC + RTM 通用的令牌（`tokenSeconds` = 3600 秒），同时把这组身份和签发时的 Agora 凭据快照存进授予。续签和启动只认这份授予，不重读当前凭据：中途改 App ID 只影响下一通电话。
- **授予的期限就是令牌的期限**：没启动的授予与令牌同时过期，续签把两者一起延长；过期的在下一次请求时清掉，服务停止时全部清空。未知、过期或已撤销的 `channel + uid` 续签和启动都回 `VoiceUnavailable`（「这通电话的语音凭据已经失效，请重新接通」），页面重新取 `/session`。
- **一份授予只有一个启动者**：启动时认领（`starting`），重复启动回「这通电话已经在接通」；启动失败撤销授予；成功后授予归通话，直到挂断。
- **一通电话记下建立时的决定**：通话存它用的 Agora client、语音线路的释放函数、是不是快嘴（`quick`）和开场白。之后改「谁接电话」、区域、凭据都不改这通电话：字幕怎么分流、停止请求发到哪个区域都按建立时的。
- **挂断一开始，字幕资格就终止**：挂断先删授予、把通话标成 `ending`，此后 `heard`、`said` 回 `VoiceAgentFailed`（「这通电话已经挂了」）；声网停止失败时保留原 client 供重试，但不再接字幕。
- **电话里的每句话由服务端记进默认频道**，带 `spoken`，不叫醒任何人：主人的话快嘴模式下由 `Orchestrator.heard` 记，管家模式下由 `Orchestrator.answerer("phone")` 记；管家的回答照常进默认频道；快嘴的回答由页面交 `/voice/agent/said`，只在快嘴模式、通话没挂时记，开场白不记。
- **农场只有一通电话**：页面的 `voiceCall`，点手机的「管家」、它通话屏上的「打给管家」和接听来电都开它、挂它；服务端的 `calls` 里没在挂断的那一通就是「正在通话」。
- **管家能主动在电话里说**（`Voice.speak`）：有一通电话就经它建立时的会话说（`session.say`，声网的 `agents.speak`，带这个会话自己的 ConvoAI token；直接调 `client.agents.speak` 不带 token，声网回 401，管家的话进了默认频道却念不出来），`priority: APPEND`（排在正在说的这句之后，不打断主人）、`interruptable`（主人能插话）；一次最多 512 字节，长的在句末切成几段（`speakPieces`，每段不超过 480 字节）。没有电话回 false。念不出来只记日志。
- **一句话只处理一次**：管家模式下 `/agent/heard` 收下但不转给管家（语音线路已经交过）；`heard` 带 `sendKey`，同一个键再交是已经听过的那句。
- **语音线路只有一个接口对外**：监听只听 127.0.0.1，只有 `POST /llm/<通话>/chat/completions`；请求要带这通电话的 `Authorization: Bearer <钥匙>`，钥匙随挂断作废。别的路径 404，没钥匙或钥匙不对 401。
- **一段听写拥有它的目标**：开始时绑定起始输入框和录音；同一时间只有一段在录，在另一个输入框按停止不改变文字去向。输入框销毁时取消这一段，迟到的转写结果不写进别的草稿。
- **语音设置一份，只存差异**：`settings.json` 的 `voice` 只存和默认不一样的字段（页面发整份，服务端去掉和默认一样的），`{}` 就是恢复默认、从文件里删掉。默认是 `defaultVoice` 再叠配置的 `voice.id`。每通电话开始时现取（设置和三段的 key 从同一版读出），存了下一通生效。

## 怎么走

**接通**（页面 `VoiceCall.start`）：

1. 浏览器先要麦克风权限。`POST /api/v1/voice/session/create` 拿 `AgoraGrant`（`appId`、`channel`、`uid`、`token`）；没凭据回 `VoiceUnavailable`（「还没有 Agora 的凭据」），别的照常。
2. 用 `host.rtc`（手机壳的声网原生 SDK，`apps/mobile/src/rtc.ts`）或页面自己的声网 Web SDK（`features/voice/agora.ts`）加入频道、发布麦克风。
3. `POST /api/v1/voice/agent/start`（`channel`、`uid`）。服务端认领授予、按当前语音设置建 vendors：
   - 「谁接电话」是管家时先开语音线路，拿到这通电话的地址和钥匙，作为 OpenAI 兼容的大模型交给 Agora，模型名 `vibevalley-orchestrator`；开不了回 `VoiceUnavailable`（「管家的语音线路接不通」）。
   - 快嘴：Agora 托管的模型、DeepSeek（用农场的 DeepSeek key，`https://api.deepseek.com/chat/completions`）或自己的 OpenAI 兼容接口（`llmKey`）。参数固定：最多 15 轮历史、`max_tokens` 512、`temperature` 0.7、`top_p` 0.95，带开场白和出错时说的话。
   - 要 key 的（微软识别 `asrKey`、自己的大模型 `llmKey`、微软合成 `ttsKey`）缺 key 就回 `VoiceUnavailable`，说缺哪个、在哪一格填；`agora-agents` 拒绝某个配置时 `vendorsFor` 接住，当作「语音设置用不了」。
   - 断句和打断：VAD，`silenceMs`（默认 480）、`interruptMs`（默认 160），`idleSeconds`（默认 30）没人就离开；字幕走 RTC 的 data stream；语音管家的 uid 固定是 `voiceAgentUid`，页面靠它分开管家的声音和字幕。
   - 请 Agora 启动（HTTP 超时 25 秒）。启动失败或被中断都撤销授予、关线路；底层启动不能取消时，迟到返回的 agent id 也立即请它离开。启动返回时服务已经停下或授予已被撤销，回 `VoiceUnavailable`。
   - 成功：记下通话，回 `agentId`；`Core.did` 让账本记一笔语音。
4. 令牌快过期时（SDK 的 `token-privilege-will-expire`）`POST /api/v1/voice/session/renew` 换同一组 `channel + uid` 的新令牌；失败在通话上显示原因。

**字幕**：页面从 data stream 收分块的消息，`captions.ts` 拼齐一轮再解，只留最近几轮。说着的时候就画在田头最下面（`liveCaptions`，淡色、带光标）：主人这一轮还在说的字随说随长；这一轮说完了留着，等田头有了同样的字（`spoken` 的那一条）就换成它，最多留 `captionLinger`（8 秒）。管家的字两种模式都画：不管谁接电话，它的话都要一段说完才进田头。

- 主人的一句定稿时，连同 `agentId`、档案选择和 `sendKey` 交 `POST /api/v1/voice/agent/hear`。快嘴模式下服务端把农场设成开着、交给 `Orchestrator.heard`：记成主人在主频道的发言，提示管家「语音那边已经回答了」，派了活才说一句派给了谁。管家模式下收下不转。
- 快嘴的一轮说完或被打断时（`turn_status` 不为 0），页面把说到的部分交 `POST /api/v1/voice/agent/say`，服务端经频道的 `spoken` 记成管家的话。
- `/voice/agent` 返回前收到的字幕，页面暂存到拿到 `agentId` 再发；取消通话清掉它们。
- `POST /api/v1/voice/hear` 没有 `agentId`：只有一通没在挂的电话时绑定到它；一通都没有回「没有正在接通的电话」，有几通回「请升级客户端后重试」。

**管家接电话**（语音线路）：

1. 监听开在 `voice.line.port`（默认 8788，只听 127.0.0.1）；端口被占时只记日志，农场照常，打给管家的电话回原因。
2. 隧道：设了 `voice.line.url` 就用它（去掉结尾的 `/`），地址固定、第一通不用等，比如 Tailscale Funnel（`tailscale funnel --bg 8788`，把它给的 `https://<机器>.<tailnet>.ts.net` 设成 `voice.line.url`；只放这条线路的端口，农场的 8787 不放）；没设时第一通电话开 cloudflared 临时隧道（`cloudflared tunnel --url`），30 秒内给不出 `trycloudflare.com` 地址就失败，没装就提示 `brew install cloudflared` 或设 `voice.line.url`；拿到地址后每 2 秒探一次，最多 60 秒，线路回 401 算通了，到时还不通也接着打，只记日志。最后一通挂了 10 分钟后关隧道，其间再打就复用。
3. 每通电话一个随机的通话 id 和钥匙；Agora 每说完一句就来一个请求。协议由 `agent/brain/openai.ts` 处理：只取 `messages` 里最后一条 `user`，交给 `Orchestrator.answerer("phone")`（先记进默认频道，再带「电话里说的、要口语」的提示问管家），管家的字边长边以 SSE 流回去念。没有主人的话时回一句「嗯？我没听清，你再说一遍？」。
4. Agora 在主人插话时挂掉请求：请求断了就不再送字；同一通电话的新一句结束上一句的流；管家这一轮照常跑完。

**管家打电话找主人**：

1. 什么时候找：Inbox 里刚来一件（[通知](docs/subsystems/notice.md)的 `Notices.news`，开机时已经在的不算，同一个 id 只算一次）；`voice` 订阅它，交给管家的是每件的 `title：body`。
2. 正在通话：要说的事进一个队列，从不挤着说。队列里第一件到了先等 3 秒（`gatherMs`），这期间到的一起写成一条「【要告诉主人】……这 N 件合成一段说」交给管家（`Orchestrator.brief`，来源是工单，排在管家手上这一轮之后，不打断电话里正在答的那句）；管家照常在默认频道回答，答完整段经 `speak` 念出来，念的请求排在正在说的话之后。这一段交出去以前不再问管家；其间来的事攒着，下一次合成一条。管家答这件事时插进来别的话（主人在电话里又问了一句），这件的回答就此结束，已经说出来的照样念；一个字都没有的放回队列再问，连着三次没字就作罢。队列是 Voice 作用域里的 Effect 循环，等待和 brief 都能被服务关闭中断；挂断会中止这通电话的 brief 等待，但不停管家共享的 run，每段 `say` 前再查通话是否还在。brief 失败记日志并结束这一轮，不盲目重发管家可能已经收到的输入；之后来的事能再开一轮。挂断以后队列清空：这些事还在手机的未接和 Inbox 里。
3. 没在通话：页面的手机照 Inbox 响铃（工单交回来带着问题的是一种「有问题问你」`ask`）。接听就是开电话：`VoiceCall.start(about)`，`about` 是响的那件事；服务端这通电话不念开场白，agent 进来后经同一个队列把「主人接起了你打的电话，你打电话是为了这件事：……（这期间又有：……）」交给管家，回答念出来作为第一句。通话中手机不响铃，来的事由第 2 步在电话里说。

**挂断**（`VoiceCall.end` → `POST /api/v1/voice/agent/stop`）：终止字幕资格、撤销授予，用建立时的 client 请 Agora 离开（它已经在走、回 404 也算成功），释放语音线路的钥匙。失败回 `VoiceAgentFailed`，通话留着可以再停。不认识的 `agentId` 用当前凭据和区域去停。服务停止时清空授予、关线路和隧道。

**听写**：

1. 点一下按钮，绑定这个输入框开始录（16 kHz 单声道，浏览器的 `AudioContext` 录成 WAV）；再点一下停。
2. 录音 base64 交 `POST /api/v1/voice/dictate`（`format`: `wav`）。服务端认 `wav`、`m4a`、`mp3`、`webm`、`ogg`、`flac`；不认识的格式、空的、不是 base64、超过 25 MB 回 `Refused`。
3. 原样转给 `POST {url}/audio/transcriptions`（multipart，带 `model`、`response_format: json`，有 `dictationKey` 就带 `Authorization: Bearer`），不加提示、不改声音，时限 2 分钟（本机模型第一次要加载）。没配地址、地址不对、连不上、对方回非 2xx（带对方的错误，留头 200 字）、回的不是转写格式，都回 `VoiceUnavailable` 和原因。
4. 回来的 `text` 插进输入框的光标处（没有光标就放末尾，只在拉丁词之间补空格），主人看过再发；发出去是一条普通的消息。

**改设置**：「设置」的「声音」（`/settings/voice`）配线路：凭据和区域、识别、语言、断句、打断、没人时多久离开、谁接电话（`answer`），和「听写」的地址、模型、key。管家页的「声音」（`/orchestrator/voice`）配电话上的管家：人设（只对快嘴有用）、开场白、出错时说的话、音色。两处是同一个 `VoiceForm`，按 `part`（`line`、`agent`）分；每处只把自己那几项叠在当前最新的设置上存，「恢复默认」只动自己那几项，两页不会互相覆盖。页面一边改一边问 `POST /api/v1/setting/check`，显示的就是保存时会被拒的理由。自己服务的 key 页面只看到最后四个字。MiniMax 音色旁边的试听播的是仓库里预先生成的样音，不连网。

听写的地址有两种用法：本机开着 [speech-swift](https://github.com/soniqo/speech-swift) 的 `speech-server`（`brew install speech`），填 `http://127.0.0.1:8080/v1`、模型 `qwen3`、key 空着，声音不出这台电脑；云上如 OpenAI 填 `https://api.openai.com/v1`、`gpt-4o-mini-transcribe` 和 key，声音送到那一家。

## 和谁打交道

- **管家（`orchestrator`）**：快嘴模式的主人字幕经 `heard`；语音线路的每句经 `answerer("phone")`，回一个字的流；它和本机 `/v1/chat/completions` 的 `answerer("api")` 共用一个回答的流，同一时间只流一个。要告诉主人的事经 `brief`：一个自己的回答流，不结束电话的那个，整段回来以后念出来。
- **频道（`channel`）**：快嘴的回答经 `spoken` 记成管家的话；主人的话和管家的回答由管家那边记。带 `spoken` 的消息不投给任何人。
- **设置（`setting`）**：声网的凭据（每次现取，存的凭据不用重启）、语音设置和三段的 key、听写的设置。
- **核心（`core`）**：`did`（账本的语音时刻）、`open`。
- **配置（`base/config.ts`）**：语音线路的端口和隧道地址。
- **页面**：`VoiceCall` 只经 `api.voice.*` 和服务端说话；田头窗口、HUD、手机读它的阶段、字幕、两条音量和管家的状态，不持有 RTC 资源；桌面壳的 ⌥⇧Space 切换它。

## 为什么这样

- **实时通话用 Agora 的 ConvoAI，照官方示例搬。** RTC 传输、回声消除、断句、插话打断和把识别、想、合成串成实时链路是难点，自己做成本远超需要；放弃了自己接识别和合成。Agora 的 SDK 参数多、变得快，照能跑通的 `agent-quickstart-nextjs` 搬，比凭记忆写快；服务端用声网的 `agora-agents`，页面用它的 Web SDK。
- **只把「想」换成我们的管家，经一个只有一个接口的监听。** 声网能接 OpenAI 兼容的自定义大模型，所以识别、断句、合成照用，管家在电话里就是田头上那个，看得到地里、自己派活。放弃了用隧道转发整个服务端：帮工能执行任意命令，派活、改配置的接口都会上公网。放弃了给托管模型塞农场上下文（它调不了我们的工具）和用 Agora 的 think 接口塞指令（措辞不进管家自己的历史）。代价是本机多一个对外口子，只认带钥匙的请求。
- **协议只取最后一句，历史以管家的会话为准。** 照 OpenAI 的语义读全部 `messages`，管家的会话和 Agora 那边的历史会是两份：插话时没念完的字、频道里说的话 Agora 都不知道。协议放在 `agent/brain`，不留在 `voice`：主服务的本机接口也用它。
- **Agora 是供应商，不是概念，不开一个 `agora` 模块。** 声网的 SDK 只在 `voice/voice.ts` 和页面的 `features/voice/call.ts` 里用，翻译设置的适配就在 `voice.ts`。页面的 `VoiceCall` 直接持有声网的 client，不拆出只有一个实现的接口；也不抽 `Transport`、`TTS` 接口，第二家真要接时再抽，能换平台靠 OpenAI 协议。
- **听写不走 Agora，转给主人填的 OpenAI 兼容地址。** 走 Agora 要开一通按分钟计费的会话、请一个 agent 进频道，能选的识别也接不上中文准的国内厂商；听写不需要断句和打断。经服务端转一手是为了 key 留在服务端、「连接到本机」进来的手机也能用 Mac 上的本地模型。放弃了服务端打包并拉起本机识别（要管约 1 GB 的模型和它的生命周期）。字去输入框、不叫醒管家；放弃了让管家整理听写：每段草稿都会进管家的会话、叫醒它一轮。
- **RTC 授予拥有这通电话的应用身份。** 三个请求各读一次当前凭据时，拿令牌后改 App ID 会让启动或续签指向另一个应用，而已经加入频道的 client 换不了身份。现有的 `channel + uid` 已由服务端生成，足以标识授予，不另加 grant id；没启动的授予用令牌的期限，不另设较短的，免得令牌还有效 `start` 却拒绝。
- **字幕归这通电话，由 `voice` 分流。** 管家按当前设置决定旁不旁听时，中途改「谁接电话」会让同一通电话的两种字幕按两份规则走；页面读设置再决定也一样受影响，还重写了服务端的规则。
- **快嘴的回答由页面上报。** 一轮结束的信号只在页面的字幕流里；页面挂得太快会少一条，有意接受，不重试。
- **一段听写拥有目标，不由停止按钮临时给写字回调。** 在每个回调里查页面存活只挡住销毁后的写字，挡不住在另一输入框按停止换掉目标。每个输入框各开一个听写器会让两处争用麦克风，所以页面里同一时间只有一段，每段管自己的目标。
- **语音设置和钥匙放在同一个 `settings.json`，只存差异，分两处改。** 单独的接口和文件会让页面两个请求、两套「存好了没」；整份存下来，默认的人设改进了，存过一次的人永远停在旧的上。拆成两份存要多一套默认和覆盖的规则；现在只有管家一个人说话，同一份数据按归属在设置页和管家页两处改就够了。页面只放听、想、说里会改的几样，VAD 阈值、前置填充这些留在代码里。加一家服务就是联合里多一个成员：`tsc` 查声音页和 `vendorsFor` 的 `switch`。
- **农场只有一处能打电话，管家用 `speak` 主动说。** 两处各开一个频道，就是两通电话抢同一个管家和同一个麦克风。线路只在声网来问时回答，管家没法在电话里先开口；`speak` 是声网给的「念一段」，管家的话仍然先进默认频道，再念出来，所以电话和默认频道是同一份上下文。放弃了念固定的模板句：主人接着追问「改了什么」，答的要是同一个管家。放弃了每件事打一通新电话：开 agent、接通隧道要几秒到几十秒，没接就白花声网的时长；只在主人接起时开。用 `APPEND` 不用 `INTERRUPT`：主人正说着被打断太粗暴，晚几秒可以接受。
- **样音预先生成、放进仓库。** 现场合成要服务端有 MiniMax、OpenAI 的 key，可平时用的是声网托管的合成；借声网录一段要等几秒、花通话时长。列表里的音色是固定的，生成一次最省事；代价是样音念的是默认开场白，OpenAI 和微软的音色没有样音。

## 还没做的

- 帮工各自的音色、频道朗读、直接给帮工打电话：[帮工各自的音色](.agents/notes/proposed/feature/2026-10-13-helper-voices.md)。

## 怎么验证

- `apps/server/src/voice/voice.test.ts`（假的声网对端）：通话中一张工单交回来，管家的话经 `speak`（`APPEND`，带会话的 ConvoAI token）念出来，没通话时不念；两张接连交回来只问管家一次、只念一段；交给管家的那条把等着的事合成一段；接听来电开的电话不念开场白、管家先说那件事；brief 拒绝后能处理下一件，brief 未完成时关闭 Voice 会取消等待，多段播报中挂断不再发后面的段；长话在句末切到 512 字节以下；说缺哪个 key；只有凭据时才签授予、续签；管家在自己的线路上接通和挂断；一通电话的凭据和线路不随之后的设置变；挂断中的电话不收字幕；没带通话 id 的字幕只在只有一通电话时转；听写没设好时说为什么。
- `setting` 的测试：语音设置只存差异、三段的 key 只给提示（`setting/*.test.ts`）。
- 页面：`apps/web/src/features/voice/captions.test.ts`（分块乱序也拼齐一轮、一轮的字长大时替换、插话停下那一轮、只留最近几轮、两边的字都画到频道有了那一句）；`apps/web/test/voice.spec.ts`（没有声网的钥匙时说为什么、再点一次重试；听写等「声音」里设好转写地址）。
- `apps/server/src/notice/inbox.test.ts`（交回来带着问题的是「有问题问你」）。
- 页面：`apps/web/src/farm/phone/calls.test.ts`（通话中不响铃、记成未接）；`apps/web/test/farm-phone.spec.ts`（接听来电就去开电话；点「管家」就拨，打不通时通话屏和田头都说原因）。
- 真人说话、听到声音要人在桌面版上亲自打一通（`acceptance/page.md`）；没有连真的声网的自动测试。`speak` 在真电话上念出来、不打断主人，要在真电话上验。
