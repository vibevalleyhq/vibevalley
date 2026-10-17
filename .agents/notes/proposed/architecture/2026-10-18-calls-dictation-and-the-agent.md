# Agent Note: 通话走 Agora，听写走识别，管家说 OpenAI 的协议

Status: proposed

## Problem

语音现在等于 Agora，可我们只在实时通话上离不开它。Agora 替我们做的分两类：

| 只有它做得好的 | 只是转手的 |
|---|---|
| RTC 音频传输、回声消除、降噪、自动增益 | 识别：ARES 以外都是第三方（Deepgram、微软……） |
| 断句（VAD）、插话打断 | 合成：MiniMax、OpenAI、微软 |
| 把识别、想、合成串成一条实时链路 | 托管的大模型（`gpt-4.1-mini` 等） |

第一列是实时通话的难点，自己做成本很高（[照官方示例搬](../../implemented/feature/2026-10-10-voice-through-agora-quickstart.md)时放弃过）。第二列不经过 Agora 也能直接调。接下来要做的智能输入（说一段话，变成输入框里的字）不需要实时链路，只要识别。而且 agora-agents-go 能接的识别里，除了 ARES 没有一家国内厂商（`agentkit/vendors/stt.go`：Amazon、AssemblyAI、Deepgram、Gemini、Google、微软、OpenAI、Sarvam、Smallest AI、Speechmatics、xAI），中文和中英混说准的阿里、豆包都接不上。

「想」这一格也被说成了一个大模型，其实它是 agent 层。选 `vibevalley` 时，Agora 的大模型一格只是一个 chat/completions 协议的接口，后面接的是管家（[语音接到我们自己的管家](../../implemented/feature/2026-10-10-voice-through-our-manager.md)）。但这个协议写死在语音线路里：`voiceLastUserText`、`voiceSSEChunk`、模型名 `vibevalley-manager` 都在 `server/internal/voice/line.go`，换一个实时平台、或者本机别的程序想和管家说话，都要再写一遍。

Agora 的说法也进了我们的形状和各层：

- **protocol**：`VoiceSettings`（`server/internal/protocol/shapes.go:1254`）的选项照抄 Agora 的供应商列表。`VoiceASRAres` 只有 Agora 有，`VoiceLLMAgora` 是 Agora 托管的模型；`Area`、`VoiceCaptions`、`VoiceSession`（`appId`、`token`）都是 Agora 的概念。这些不分通话和别的，看不出哪些只在通话里有效。
- **服务端**：`server/internal/voice/agora.go` 直接 import `agentkit/vendors`；SDK 的封装在 `server/pkg/agora`。没有一条规则说 Agora 只能在这两处。
- **客户端**：`app/lib/voice/voice.dart` 里既有通话的状态（阶段、字幕、音量），又有 `agora_rtc_engine` 的调用。

还有一个行为上的缺口：电话不算管家的对话入口。默认模式下 `Heard` 以 `Quiet: true` 交给管家（`server/internal/manager/manager.go:703`），主人的话和管家的回答都不进田头；`vibevalley` 模式下管家的回答进了，主人说的那句没有（`Call` 不调用 `chat.Say`）。

## Proposal

语音分成三块，各有各的主人：

| 块 | 做什么 | 用谁 | 进来的字去哪 |
|---|---|---|---|
| **通话** | 和管家实时说话 | Agora：传输、识别、断句、打断、合成 | 「想」这一格调管家的 OpenAI 接口（或一张快嘴），说的话进田头 |
| **听写** | 说一段话，变成输入框里的字 | 我们自己接的识别厂商，不经过 Agora | 输入框，主人看过再发；不叫醒管家 |
| **agent 的 OpenAI 接口** | 让任何说 chat/completions 的程序和管家说话 | `pkg/agent` 的协议层 + 管家 | 管家的会话 |

```
  通话                                      听写
  App ─RTC─ Agora 云（识别·断句·合成）       App ─WebSocket─ 服务端 ─ 识别厂商
                  │ chat/completions                   │ 热词取自农场
                  ▼ 经隧道                              ▼ 可选：整理一遍
  语音线路 127.0.0.1:8788（每通电话一把钥匙）           输入框
                  │
                  ▼
  pkg/agent 的 OpenAI 协议层 ──► 管家（会话·工具·记性）◄── 田头、工单串、巡查
```

### 1. agent 说 OpenAI 的协议

`server/pkg/agent` 加一个只管协议的处理函数，从 `voice/line.go` 里搬出来：解析 `POST …/chat/completions`，按 `stream` 回 `chat.completion.chunk` 的 SSE 或一个完整的 `chat.completion`。它不知道管家、不知道钥匙，只接一个按模型名选谁答的函数：

```go
// One turn's words as they come; the channel closes when the turn is over. nil: no such model.
Answerer func(model string) func(ctx context.Context, text string) <-chan string
```

协议上的取舍，写进处理函数的注释和 [voice.md](../../../../docs/reference/voice.md)：

- **有状态的 agent，无状态的协议**：请求里的 `messages` 只取最后一条 `user`；`system` 和前面的几轮不读。对话的历史以管家自己的会话为准，人设也用管家自己的提示。
- **只出字**：请求里的 `tools` 不读，回的只有 `delta.content`。管家调工具在里面做完，外面看到的是它说的话。`usage` 不填。
- **`model` 决定和谁说**：`vibevalley-manager` 是管家；不认识的返回 OpenAI 格式的 `404 model_not_found`。以后主人直接给帮工打电话，就是 `vibevalley-<档案 id>`，协议层不用改。
- **断开就停**：请求的 context 结束（Agora 在主人插话时会挂掉请求），就不再送字；管家这一轮照常跑完，没念出的字留在它的历史里。
- **报错也照 OpenAI 的格式**：`{"error":{"message":…,"type":…}}`，401、400、404 各一种。

挂在两个地方：

- **语音线路**（`internal/voice/line.go`，已有）：只认路径里那通电话的钥匙，经隧道给 Agora。线路只剩监听、钥匙和隧道。
- **主服务的 `/v1/chat/completions`**（新加，只听 127.0.0.1，和 `/mcp` 一样）：本机的程序和测试直接用。`curl` 就能和管家说一句，也让以后接别的实时平台时，先在本机试通再开隧道。

只做 OpenAI 的协议，不做别的：LiveKit、Pipecat 这类实时平台接自定义大模型时，多半也认这一个协议。

### 2. 通话：Agora 的代码收在一处

照 connector 的做法（概念在 `internal/connector`，每家的封装在 `pkg/weixin` 这样的包，适配各一个文件），不另开 `internal/agora`：

| 层 | Agora 只能出现在 | 其他地方看到的 |
|---|---|---|
| 服务端 | `server/pkg/agora`（令牌、请 agent）和 `server/internal/voice/agora.go`（把通话设置翻译成 Agora 的 vendors 和参数） | `voice.Service` 的 `Session`、`Renew`、`Start`、`Stop` |
| 客户端 | `app/lib/voice/`（`voice.dart` 里的引擎、`captions.dart` 的分块格式） | `VoiceCall`：阶段、字幕、两条音量、管家的状态 |

- 检查：`server/internal/voice/agora_boundary_test.go` 扫整个 `server/` 的 import，`github.com/AgoraIO/` 只在上表两处；`scripts/app-imports.ts` 的 `VENDOR`，`package:agora_rtc_engine` 只在 `app/lib/voice/`。
- vendors 的构造留在 `voice/agora.go`：它要读 `protocol` 的设置，搬进 `pkg/agora` 就得在那边再写一份同样的选项类型。
- 客户端不再拆文件：`VoiceCall` 直接持有 `RtcEngine`，测试也伪造它（`app/test/voice/lifecycle_test.dart`）；拆成 `agora.dart` 就要在中间造一个只有一个实现的接口。界面只用 `VoiceCall`，边界已经在 `lib/voice/` 这一层。
- 通话里的识别和合成仍由 Agora 调。断句、打断和识别绑在一起，拆出来就要自己做实时链路。
- 现在不抽「实时平台」接口：第二家真要接时再抽。能换平台的关键是第 1 节的 OpenAI 接口，不是 Go 里的接口。

电话是管家的一个对话入口，两种「想」下都进田头的主频道：

- 主人说的每一句（最终的识别结果）记成主人在主频道的发言，由服务端记：快嘴模式下是 `manager/hear` 那一句，管家模式下是语音线路取到的那一句。
- 管家模式：管家的回答照今天一样进田头。
- 快嘴模式：快嘴的回答由客户端在一轮结束时（`assistant.transcription` 的 `turn_status` 不为 0）交给服务端，记进田头并标明是语音里说的。管家旁听不再 `Quiet`；提示里说明语音那边已经回答过，免得一句话回两遍。

### 3. 听写：普通的识别，不经过 Agora

- **接口**：`GET /api/v1/voice/dictate` 升级成 WebSocket。客户端送 16 kHz 单声道 PCM 和一个 `end`，服务端回 `partial`（还在变）和 `final`（定了）。走服务端，不在客户端直连厂商：key 只在服务端，热词要用服务端的农场状态。
- **识别厂商**：`internal/voice` 里一个不导出的接口，消费方定义：

  ```go
  type recognizer interface {
  	Recognize(ctx context.Context, audio <-chan []byte, hints []string) <-chan protocol.DictationText
  }
  ```

  每家的封装在 `server/pkg/<厂商>`，适配在 `internal/voice/dictate_<厂商>.go`。这里一开始就用接口，因为至少有两种：云上的一家，和本机的一种（SenseVoice / Paraformer 经 sherpa-onnx，不联网也能用）。先接哪家另定，候选是阿里 Fun-ASR / Paraformer 实时和豆包流式，两家都能流式出字、带热词。
- **热词取自农场**：项目名、档案名（阿郑、小吴）、正在干的工单标题，由 `voice` 里一个纯函数从 `CoreState` 算出来，直接测。这是通用输入法给不了的。
- **整理一遍**（可选，默认关）：识别定稿以后，用 DeepSeek 做一次补标点、改错字、改正术语。这一次不走管家：管家的会话是对话的历史，听写的草稿不应进去，也不应叫醒它。所以「这一格是 agent」只说通话，听写的整理是一次普通的模型调用。
- **字去输入框**：田头、工单串、派活的输入框都能用；主人发出去以后，就是一条普通的消息。

### 4. 形状

`VoiceSettings` 就是通话的设置，也就是 Agora 实现的设置；听写的设置以后是它旁边单独的 `dictation`，不放进 `voice`。

- `answer`（原来的 `llm`）：谁接电话，`VoiceAnswer`。`manager` 是管家自己接（原来的 `vibevalley`），模型归管家的档案（[管家是一份内置档案](2026-10-17-manager-is-an-agent.md)）；`agora`、`deepseek`、`openai` 是快嘴，只会说话，管家旁听派活。
- `asr`、`tts`：Agora 能接的厂商，名字照实写；听写的识别是另一个联合类型。
- 人设、开场白、出错时说的话、`Area`、`SilenceMs`、`InterruptMs`、`IdleSeconds` 都留在 `voice` 里。人设只对快嘴有用，声音页上标明了。
- `VoiceCaptions` 删掉：字幕固定走 RTC 的 data stream，写在 `voice/agora.go` 里（`pkg/agora` 还认 RTM，给别的用法）。
- `VoiceSession` 改名 `AgoraTicket`：Agora 进频道的票，不做成联合类型。
- 凭据：`AgoraAppID`、`AgoraAppCertificate` 名字不变；听写厂商的 key 和 `ASRKey` 这类分开放，各自写明是哪一块的。
- 存盘：只认新的名字。主人的家里 `settings.json` 没有 `voice`（2026-10-18 看过），不用搬。

### 步骤

每步单独一个改动，各自能过检查：

1. **OpenAI 协议层**（第 1 节）：从 `line.go` 搬进 `pkg/agent`，语音线路改用它，加 `/v1/chat/completions`。语音的行为不变。
2. **守住 Agora 的边界**（第 2 节的表）：加 import 检查，代码不挪。
3. **电话进田头**（第 2 节的后半）：只改行为；改完更新 voice.md。
4. **改形状**（第 4 节）：改 `protocol`、跑 `shapegen`、改声音页。
5. **听写**（第 3 节，和 `voice` 并列的 `dictation`）：先接一家云上的厂商和热词，再做整理，最后做本机的识别。

量过真实通话的延迟以后，再决定 `call.answer` 的默认值。这一步不在本提案里。

### 做到哪了

2026-10-18 做了第 1 步：`pkg/agent/openai.go` 的 `ChatCompletions`，语音线路（`voice/line.go`）只剩路由和钥匙；主服务挂了 `protocol.ChatCompletionsPath`（`/v1/chat/completions`），模型名是 `protocol.ManagerModel`。同一天做了第 2 步：Agora 本来就只在上表的几处，加了两条检查守住它。第 3 步也做了：消息多了 `spoken`（`ChatMessage.Spoken`，存在 `chatMeta`），`chatAudience` 见到它不投给任何人；主人的话由 `Manager.Heard`（快嘴）或 `Manager.Call`（管家）记，快嘴的回答由客户端的 `LiveCaptions.onAnswered` 交给 `POST /api/v1/voice/agent/said`，服务端只收还没挂、开始时「想」不是管家的那一通，开场白不记。管家旁听不再 `Quiet`，提示里让它派了活才说一句。第 4 步也做了，见第 4 节。管家的 `Call`（电话里的话，带语音的提示）和 `Answerer`（本机的 chat/completions，当作田头里的话）共用一个 `answer`：同一时间只流一个回答，新的一句结束上一个的流。

待定：

- 听写的名字（`dictation`、`tidy`）和界面上叫什么，做第 5 步时定；通话在界面上仍叫「听」「想」「说」，「想」里的那一项叫「谁接电话」。

## Alternatives considered

**另开一个 `internal/agora` 服务。** `internal` 的包按业务概念分；Agora 是供应商，不是概念。开成服务以后，`voice` 和 `agora` 分不清谁拥有通话。connector 已经有现成的样子。

**听写也走 Agora。** 要开一通 ConvoAI 的会话才能识别，按分钟计费，还会请一个 agent 进频道；能选的识别厂商也只有它列表里那几家，中文准的接不上。听写不需要断句和打断。

**通话的识别也换成我们自己的。** 识别和断句、打断绑在一起，换掉就要自己做实时链路，[照官方示例搬](../../implemented/feature/2026-10-10-voice-through-agora-quickstart.md)时否决过。

**OpenAI 协议层留在 `voice` 里。** 只有语音线路用它的时候没问题；可主服务的本机接口、以后给帮工打电话都要用。协议和管家无关，放在 `pkg/agent`，任何一个 `vvagent.Agent` 都能挂。

**协议层照 OpenAI 的语义，每次读全部 `messages`。** 那样管家的会话和 Agora 那边的历史是两份，会对不上：插话时没念完的字、田头里说的话，Agora 都不知道。以管家的会话为准，只取最后一句。

**听写的整理交给管家。** 管家能看到农场，改术语会更准；但每段草稿都会进管家的会话、叫醒它一轮。热词已经带上了农场的名字，整理只要补标点、改错字。

**现在就抽出 `Transport`、`TTS` 接口。** 只有一个实现，形状会照着 Agora 长。只有听写的识别一开始就有两种实现（云上和本机），所以只给它接口。

## Acceptance criteria

- `curl` 主服务的 `/v1/chat/completions`（`model: vibevalley-manager`、`stream: true`）能拿到管家的回答，SSE 以 `finish_reason: stop` 和 `[DONE]` 结束；`stream: false` 回一个完整的 `chat.completion`；不认识的 `model` 回 404。
- `server/internal/voice/line.go` 里没有 OpenAI 协议的代码；语音线路的测试照旧通过。
- `github.com/AgoraIO/` 只在 `server/pkg/agora` 和 `server/internal/voice/agora.go`，`package:agora_rtc_engine` 只在 `app/lib/voice/`；在别处加一行 import，`go test ./...` 或 `bun run app:imports` 报错。
- `protocol` 里带 Agora 名字、或只有 Agora 才懂的字段，都在 `VoiceSettings` 下（和 `AgoraTicket`、凭据）；`VoiceCaptions` 不在了，「想」是 `answer`。
- 两种 `answer` 下打一通电话，挂了以后田头主频道里有主人说的每一句和对应的回答（照 `verify-server` 查频道的消息；真人说话照 `verify-app`）。
- 听写：对着 WebSocket 送一段录好的中英混说的 PCM，`final` 里的项目名、档案名和农场里的写法一致；识别失败时输入框保留已有的字，并说明原因。
- `go vet ./... && go test ./...`、`bun run go:deadcode`、`bun run flutter:check` 通过。

## Risks

- 主服务多了一个能让管家干活的接口。它只听 127.0.0.1，和 `/mcp`、`/api` 一样；院门只放 `VibeValleyApi` 和状态流（`server/internal/gate/gate.go:32`），`/v1/…` 不在里面。放进 `/api/v1/…` 的话，院门会放行，要另外拦。
- 本机的 `/v1/chat/completions` 和电话共用一个回答的流：打着电话时本机来一个请求，电话里那一句的流会被结束。只有一个主人，有意接受；要并行时再给每个请求一个自己的 `managerCaller`。
- 语音线路以外，任何本机程序都能经 `/v1/chat/completions` 让管家派活。这和本机能调 `/api` 是同一个信任边界，有意接受。
- 协议只取最后一句：Agora 重发同一个请求时，管家会听到两遍。要在真实通话里看是否发生。
- 听写把主人的声音送到第三方厂商。声音页上要写明送给了谁；本机识别做出来以前，不想上传的只能不用听写。
- 第 4 步改了存盘的名字（`llm` → `answer`，`vibevalley` → `manager`），不搬旧的：别的机器上存过「想」的 `settings.json`，「想」会回到默认，要在声音页重选一次。
- 快嘴的回答由客户端上报，客户端挂得太快会少一条；有意接受，不加重试。
- 有意放弃的：不支持第二家实时平台的 Go 接口，不做不实时的合成；能换平台靠 OpenAI 接口，合成等[帮工各自的音色](../feature/2026-10-13-helper-voices.md)来用。
