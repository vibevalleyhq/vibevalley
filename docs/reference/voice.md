# 语音：和管家说话（Agora ConvoAI）

按田头窗口里的麦克风和管家语音对话，说的活会派到农场上。识别和合成是 Agora 的，「想」有两种：

- **农场的管家**：田头上那个管家本人接电话，看得到地里、自己派活，经「语音线路」接到声网。
- **别的大模型**（声网托管、DeepSeek、自己的接口）：出声回答的语音管家看不到地里；它听到的一句话，客户端再交给农场的管家去派活。

照 Agora 的官方示例 `agent-quickstart-nextjs` 写成（[理由](../../.agents/notes/implemented/feature/2026-10-10-voice-through-agora-quickstart.md)、[语音线路](../../.agents/notes/implemented/feature/2026-10-10-voice-through-our-manager.md)）。

## 服务端

`server/internal/voice/agora.go`（`Workspace` 上的 `Voice`）；签令牌、拼语音管家的请求在 `server/pkg/agora`。

- `POST /api/v1/voice/session` 开一个频道和数字 uid，签一个 RTC + RTM 通用的令牌，一小时过期。服务端把这组频道、uid 和签发时的 Agora 凭据绑定；`/renew` 和请语音管家进频道都使用这份凭据，中途改设置只影响下一通电话。
- 没启动的通话凭据与令牌同时过期，续签延长有效期；启动失败、开始挂断或服务端停止时撤销。未知、过期或已撤销的频道和 uid 不能续签或启动，客户端重新取 `/session` 接通。
- `POST /api/v1/voice/agent` 按语音设置请语音管家进频道；`/agent/stop` 请它离开，它已经在走也算成功。
- `POST /api/v1/voice/agent/heard` 交来主人说的话（`agentId`、`text`、可选的档案 `agent`，和 `say` 一样的 `sendKey`：同一个键再交是已经听过的那句）；通话按建立时的模式决定是否交给管家旁听。`/agent/said` 交来托管模型说的话（`agentId`、`text`），只在快嘴模式记进田头，开场白不记。开始挂断后，两种字幕都回 `VoiceAgentFailed`，不受下一通电话的设置影响。
- 凭据缺了返回带原因的 `VoiceUnavailable`，别的照常。

## 客户端

`app/lib/voice/`（`VoiceCall`）：从服务端取令牌，用 Agora 的 Flutter SDK 加入频道。Flutter 的 RTM 只有移动端，所以字幕、打断和语音管家的状态都走 RTC 的 data stream（`captions.dart` 拼块再解）。令牌快过期时换新的。只链语音要的 Agora 组件（`app/tool/agora-voice-only.sh`）。

通话进田头的主频道，和打字一样看得到；这些消息带 `spoken`，不叫醒任何人（管家已经在电话里听到了）。

- 你说的：字幕定稿时连同这通电话的 `agentId` 交给农场（`POST /api/v1/voice/agent/heard`）。快嘴模式下，服务端记成你的发言并交给管家派活；管家自己接电话时，这份字幕不再转交，由语音线路记录。同一通电话中途修改「谁接电话」，不改变它的转话方式。
- 托管模型说的：一轮说完或被你打断时，客户端把它说到的部分交给 `/voice/agent/said`。

旧客户端的 v1 `/manager/hear` 入口保留：只有一通有效电话时绑定到它；没有电话或有几通无法区分时拒绝。新客户端使用带 `agentId` 的入口。

## 听写

田头输入框旁的录音按钮（`app/lib/chat/dictation_button.dart`，录音在 `app/lib/voice/dictation.dart`）：点一下开始说，再点一下停；录好的一段（16 kHz 单声道 WAV）交给 `POST /api/v1/voice/dictate`，识别出的字插进输入框的光标处，看过再发。不经过 Agora，也不叫醒谁。

服务端（`server/internal/voice/dictate.go`）只转交：把录音原样发给设置里的 OpenAI 兼容转写地址（`POST {url}/audio/transcriptions`，带 `model`，有凭据就带 `Authorization`），把回来的 `text` 交回去。不加提示、不改声音。没配地址、连不上、对方拒绝，都回带原因的 `VoiceUnavailable`；录音格式不认识、是空的、超过 25 MB 回 `Refused`。

设置在工作台「声音」页的「听写」，存在 `settings.json` 的 `dictation`（`url`、`model`）和 `dictationKey`：

- 本机：开着 [speech-swift](https://github.com/soniqo/speech-swift) 的 `speech-server`（`brew install speech`），地址 `http://127.0.0.1:8080/v1`，模型 `qwen3`，凭据空着；声音不出这台电脑。
- 云上：OpenAI 是 `https://api.openai.com/v1` 和 `gpt-4o-mini-transcribe`，填 key；别家 OpenAI 兼容的同理。

经院门连进来的手机也能用：录音交给 Mac 上的服务端，由它转给这个地址。

一段听写绑定开始录音的输入框，另一个按钮停止它也不会改变文字去向。输入框销毁或农场切换时取消本次听写；迟到的权限、录音启动和转写结果不能再次打开麦克风或写进别的草稿，临时录音随本次听写清理。

## 凭据

Agora 的 App ID 和 App Certificate 在「设置」的「Agora 语音」或「声音」里填，存在 `$VIBEVALLEY_HOME/settings.json`；也可以写进配置的 `agora.app_id`、`agora.app_certificate`，或者设环境变量 `AGORA_APP_ID`、`AGORA_APP_CERTIFICATE`。谁优先见 [server.md](server.md)「设置」。这些都不进仓库。

## 配置（`/settings/voice`、`/manager/voice`）

语音设置存在 `settings.json` 的 `voice`，只存和默认不一样的（页面发整份，服务端存的时候自己去掉和默认一样的），下一通电话生效。页面上一边改一边问 `POST /api/v1/settings/check`，说的就是保存时会被拒的理由。分两处改（[理由](../../.agents/notes/implemented/feature/2026-10-13-agent-pages-memory-and-voice.md)）：

- 「设置」里的「声音」（`/settings/voice`）配**线路**：凭据和区域、怎么听（识别、语言、断句、打断）、谁接电话（`answer`：管家自己接，或者一个快嘴模型先答、管家旁听派活）。
- 管家页的「声音」（`/manager/voice`）配**电话上的管家**：人设、开场白、出错时说的话、音色。

每一段可以用声网托管的，也可以换成自己的服务（微软 Azure、OpenAI 兼容的接口……），自己服务的 key 存在 `settings.json`，页面只看到最后四个字；缺 key 时开始通话就说缺哪个。字段在 `protocol/shapes.go`（`VoiceSettings`，「想」是 `answer`，`VoiceAnswer`），默认在 `protocol/voice.go`（`DefaultVoice`），几个数的范围是 `shapes.go` 开头的共用常量，保存前的检查在 `setting/voice_rules.go`。MiniMax 音色的样音在 `app/assets/voice-samples/`，试听不连网。

## 语音线路（「想」选农场的管家时）

`server/internal/voice/line.go`：声网按 OpenAI Chat Completions 协议来问管家（`model` 是 `vibevalley-manager`），管家的话边生成边以 SSE 流回去念。协议和本机的 `/v1/chat/completions` 是同一份（`internal/agent/brain/openai.go`，[管家](../subsystems/manager.md)），线路只管监听、钥匙和隧道。

- **只有这一个接口对外**：另开一个监听（配置的 `voice.line.port`，默认 8788，只听 127.0.0.1），上面只有 `POST /llm/<通话>/chat/completions`。端口被占时只记日志，农场照常。
- **隧道**：设了 `voice.line.url` 就用它；没设时第一通电话开一个 cloudflared 临时隧道，等它能应答（最多 60 秒），最后一通挂了 10 分钟后关掉。
- **每通电话一把钥匙**：声网的请求要带 `Authorization: Bearer <钥匙>`，挂了就作废。
- 只取最新的一句交给管家（`Manager.Call`），对话历史以管家自己的会话为准；声网打断时丢掉正在念的。这一句先记进田头（带 `spoken`），管家的回答照常进田头。
- 这通电话的字幕入口不再转给管家，免得一句话处理两次。
