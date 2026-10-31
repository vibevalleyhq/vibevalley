# Agent Note: 自己的实时模型经本机 WebSocket 接电话，其余照旧走声网

Status: proposed

## Problem

现在每通电话都经声网的对话式 AI（ConvoAI）：要 Agora 的 App ID 和证书；「谁接电话」选管家时，声网的云要连回本机的语音线路，所以要开隧道（cloudflared 的临时隧道或 Tailscale Funnel），第一通电话最多等 30 秒拿地址、60 秒探通。这条线路是服务端「只听 127.0.0.1」之外的一个例外（[语音](docs/subsystems/voice.md)）。

只在这台电脑前打电话、手上有一个实时模型（OpenAI Realtime 或兼容它的接口）的人，用不着这些。实时模型的连接是本机连出去的，模型要调工具时，请求顺着同一条连接回来，没有从外面进来的请求。声网替我们做的 RTC 传输（UDP、抖动缓冲、丢包补偿、手机锁屏不断）在本机和局域网上用处不大。

`apps/server/src/voice/voice.ts` 把两件事写在一起：一通电话在农场里的样子（只有一通、管家主动说的队列、田头里记什么、挂断），和声网这一家供应商（授予、令牌、vendors、语音线路、隧道）。页面的 `VoiceCall` 直接持有声网的 client，字幕按声网 data stream 的格式解。加第二种接法之前要先把这两层分开。

## Proposal

### 先验证通话，再接完整产品流程

本篇先实施隔离的技术验证：录放音、外放回声、插话截断、工具调管家和转写去重。用假实时服务验证事件顺序、断线与取消；真实供应商试验另记录协议版本、音频格式、首字延迟和费用，付费调用前取得授权。第三方协议字段在实施时按官方资料核对。

技术验证通过后再做下文的配置、字幕、主动播报和完整宿主集成。第一阶段成功不代表电话产品已交付；最终仍须满足本文全部验收条件。暂不把这条线与画布或全仓运行时改造绑定。


### 1. 「谁接电话」多一种：自己的实时模型

`VoiceAnswer` 加一个成员 `VoiceAnswerRealtime`：`{ vendor: "realtime"; url: string; model: string; voice: string }`，key 是 `settings.json` 的 `realtimeKey`（和 `llmKey` 一样，页面只看到最后四个字）。选它的电话走本机的 WebSocket，不经声网；选别的（管家、声网托管、DeepSeek、自己的 OpenAI 兼容接口）照旧走声网。默认不变（管家，经声网）。

- 只认 OpenAI Realtime 的协议（`wss://…/v1/realtime?model=…`）。Gemini Live、通义、豆包的协议各不一样，要接时各加一个成员，不在本篇做。
- 识别、合成、区域和 `interruptMs` 只对声网有用，选了实时模型时声音页不显示它们。`silenceMs` 交给实时模型的断句（`turn_detection.silence_duration_ms`），`idleSeconds` 由服务端自己计时。
- 不要 Agora 凭据，不开语音线路，不开隧道。

### 2. 实时模型是嘴，农场的事问管家

实时模型自己接话（寒暄、确认、「我看一下」）。农场里的事（帮工、工单、派活、进度、记性）由它调工具 `ask_orchestrator`：把主人的原话交给管家，再把管家的回答用口语说出来。开口快，管家的上下文仍是一份。

- 工具在服务端的进程里执行，不经网络。`Orchestrator` 加一个入口（暂名 `consult(request, signal)`）：把这句作为主人在电话里问的交给管家这一轮，回答边长边进田头（管家的话），整段返回给工具。挂断或主人插话时由 `signal` 结束这次等待，不停管家共享的 run（和 `brief` 一样）。
- 模型的人设（`instructions`）由服务端写：它是管家在电话上的嘴，看不到农场；哪些事必须问管家；管家的回答照着说，不加不改。声音页的「人设」一栏对它生效。
- 管家主动说（`brief` 的回答，声网那边经 `speak`）：服务端等正在说的这一轮结束，再开一轮 `response.create`，带上「把下面这段告诉主人」和原文，不打断主人。

### 3. 田头里记什么

两边的转写都在服务端，田头里只留一份：

| 电话里 | 田头 |
|---|---|
| 主人说完的一句（输入转写定稿） | 经 `spoken` 记成主人的话，不叫醒谁 |
| 模型自己开的一轮的回答 | 经 `spoken` 记成管家的话 |
| 服务端开的一轮（工具返回后、`brief` 后）转述的管家原话 | 不记：管家的原话已经在田头 |
| `ask_orchestrator` | 管家的回答照常进田头；问的那句不另记（主人的原话已经记了） |

实时的电话不用 `Orchestrator.heard` 旁听：管家只经工具进来，旁听会让同一句处理两次。页面不上报 `heard`、`said`。

### 4. 服务端的模块

`apps/server/src/voice/` 按「一通电话」和「怎么接」分开：

| 文件 | 管什么 |
|---|---|
| `voice.ts`（`Voice`） | 一通电话在农场里的样子，和接法无关：只有一通、开始时按设置选接法、`tell` 和 `drain` 的队列、`speak`、挂断、账本记一笔 |
| `agora.ts` | 声网：授予和令牌、`vendorsFor`、`agentFor`、开和停 agent、`speakPieces`、`heard`、`said`；`agora-token`、`agora-agents` 只在这里 |
| `line.ts` | 语音线路和隧道，只有声网用 |
| `realtime.ts` | 实时模型：连出去的 WebSocket、`session.update`（人设、音色、断句、工具、转写）、音频转发、插话时截断、`ask_orchestrator`、田头的记录 |
| `dictation.ts` | 听写，和电话无关 |

两种接法交给 `voice.ts` 同一个形状（模块里不导出）：

```ts
interface OpenCall {
  readonly answeredBy: "orchestrator" | "agora" | "realtime";
  /** Words read out after what is being said; false when the call is gone. */
  readonly say: (text: string) => Effect.Effect<boolean>;
  readonly stop: Effect.Effect<void, ApiError>;
  readonly life: AbortController;
  ending: boolean;
}
```

`drain` 的队列只调 `call.say`，不再知道声网的 `session.say` 和 512 字节的切段。

### 5. 协议和接口

- `voice.session` 回一个联合：`{ via: "agora", appId, channel, uid, token }` 或 `{ via: "realtime" }`。页面照它选接法，不自己读设置判断。
- 实时的电话是一条 WebSocket：`GET /api/v1/voice/realtime`，挂在 8787 上，用 `HttpServerRequest.upgrade`，写在 `http/` 里，和三条 SSE 并列。它不进 `endpoints` 表（表是一问一答）。
- **upgrade 先查 `Origin`。** WebSocket 不受 CORS 限制，别的网页也能直接连 `ws://127.0.0.1:8787`；连上就能经 `ask_orchestrator` 让管家派活、帮工执行命令。只认农场自己的页面（服务端提供页面的源、桌面壳的源），别的回 403，有测试。
- 只给这台电脑用：「连接到本机」不转发 upgrade；经它进来的设备，在设置选了实时模型时，`voice.session` 回 `VoiceUnavailable`（「实时模型只能在这台电脑上打」）。
- 帧：二进制帧是 PCM16 单声道（采样率由服务端在 `ready` 里说，OpenAI 是 24 kHz）；文字帧是 JSON 的控制消息，形状和 Schema 在 protocol（`RealtimeUp`、`RealtimeDown`）：
  - 页面 → 服务端：`start`（`about`、选的帮工）、`mute`、`played`（插话时正在放的那一段放到了第几毫秒）、`end`。
  - 服务端 → 页面：`ready`、`state`（听、想、说）、`caption`（谁、第几轮、字、说完没有）、`interrupt`（停掉播放、清空缓冲）、`problem`、`bye`。
- 服务端 → 实时模型：`Socket.makeWebSocket`，带 `Authorization: Bearer <realtimeKey>`。音频的 base64 编解码由服务端做，key 不出服务端。
- 插话：实时模型发来 `input_audio_buffer.speech_started` → 服务端给页面 `interrupt` → 页面立刻停播，回 `played` → 服务端发 `conversation.item.truncate`（`audio_end_ms`）。

### 6. 页面的模块

`apps/web/src/voice/`：

- `call.ts` 的 `VoiceCall` 只留阶段、静音、音量、字幕和问题，接通和挂断交给接法：`agoraPath.ts`（现在的 `run`：授予、`host.rtc` 或 `agora.ts`、`voice.start`、续签）和 `realtimePath.ts`（WebSocket、录音和播放的 AudioWorklet、控制消息）。
- `captions.ts`：声网 data stream 的拼块只给声网用；实时的字幕已经按轮从服务端来，直接进 `LiveCaptions`。
- 录音用 `getUserMedia`，开回声消除、降噪和自动增益。

## Alternatives considered

- **管家答每一句，实时模型只当耳朵和嘴**（`create_response: false`：主人每说完一句交给管家，管家的字交模型念）：上下文最干净，但首字要等转写定稿、管家一轮、模型合成三段，还要模型逐字念，而它会改词。声网的管家线路已经是这种接法。先做工具的这种，量过延迟再看要不要加。
- **浏览器直连厂商的 WebRTC**（服务端发临时 key）：声音最好，回声消除现成；但只有 OpenAI 支持，工具调用和转写要经页面转，田头记什么又回到页面上报。留作回声压不住时的退路。
- **页面到服务端也走 WebRTC**：本机上 UDP、抖动缓冲、拥塞控制都用不上，服务端要多一套 WebRTC 栈和 Opus 编解码。唯一的好处是回声消除，用页面里的回环解决（见 Risks）。
- **走声网的 MLLM 模式**（`agora-agents` 的 `withMllm`）：仍要 Agora 凭据，工具要从声网的云调进来，又是一个公网入口；`speak` 在 MLLM 模式下能不能用，SDK 没写。
- **设置拆成顶层两种（声网的三段 | 实时模型）**：选实时模型时识别和合成确实没有意义；但要多一套默认值和只存差异的规则，换来的只是声音页少两栏。「人设」只对快嘴有用，已经是同样的先例。

## Acceptance criteria

- 只填实时模型的地址、模型和 key，不填 Agora 凭据、不开隧道，在桌面版上点「管家」能接通、对话、挂断；服务端没有多开监听，`lines()` 是 0。
- 问农场的事（「现在谁在干活」「帮我开一张工单……」）时模型调 `ask_orchestrator`，照着说出管家的回答；工单真的开了；田头里主人的话和管家的回答各一条，没有转述的那一份。
- 通话中一张工单交回来，管家的话排在正在说的这句之后念出来，不打断主人。
- 主人插话时播放马上停，`conversation.item.truncate` 的 `audio_end_ms` 和页面实际放到的位置一致。
- 外放（不戴耳机）打一通 3 分钟的电话，模型没有把自己的声音当成主人的话。
- 别的源连 `/api/v1/voice/realtime` 被拒（403）；经「连接到本机」进来的设备选了实时模型时得到原因；都有测试。
- 选声网的几种照旧：`voice.test.ts` 原有的用例都过。
- 测试：`realtime.test.ts` 用本机的假实时服务端（照 OpenAI Realtime 的事件）跑接通、转写进田头、工具调管家、插话截断、挂断、厂商断开；`voice.test.ts` 的队列用例对两种接法各跑一遍；页面的 Playwright 对着假实时服务端接通和挂断。
- [语音](docs/subsystems/voice.md) 改成两种接法：模块、协议、田头记什么、为什么这样。

## Risks

- **回声**：不走 WebRTC 时，浏览器的回声消除不一定把页面自己放的声音当参照，外放时模型可能听到自己。先在桌面版上测；不行就在页面里建一对互连的 `RTCPeerConnection`，让模型的声音经它播放（WebRTC 只在页面里）；再不行就退到浏览器直连。
- **转述走样**：田头里是管家的原话，主人听到的是模型的转述，可能改词、漏事。人设里要求照着说；验收时对比几通电话的转写。
- **首字延迟**：要问管家的那一句仍要等管家跑一轮。模型先说「我看一下」能盖住一部分，量过再定。
- **花费没有上限**：实时模型按音频 token 计费，不进 `spend.json` 的每日预算。本篇只在账本上记一笔语音，花费记账另做。
- **跨境线路**：服务端到厂商这一段走公网 TCP。丢包时上行的声音晚到，断句随之变慢；下行有页面的播放缓冲兜着。
