# 语音：和管家说话（Agora ConvoAI）

按田头窗口里的麦克风和管家语音对话，说的活会派到农场上。识别和合成是 Agora 的，「想」有两种：

- **农场的管家**：田头上那个管家本人接电话，看得到地里、自己派活，经「语音线路」接到声网。
- **别的大模型**（声网托管、DeepSeek、自己的接口）：出声回答的语音管家看不到地里；它听到的一句话，客户端再交给农场的管家去派活。

照 Agora 的官方示例 `agent-quickstart-nextjs` 写成（[理由](../../.agents/notes/implemented/feature/2026-10-10-voice-through-agora-quickstart.md)、[语音线路](../../.agents/notes/implemented/feature/2026-10-10-voice-through-our-manager.md)）。

## 服务端

`server/internal/voice/agora.go`（`Workspace` 上的 `Voice`）；签令牌、拼语音管家的请求在 `server/pkg/agora`。

- `POST /api/voice/session` 开一个频道和数字 uid，签一个 RTC + RTM 通用的令牌，一小时过期；`/renew` 续一个。
- `POST /api/voice/agent` 按语音设置请语音管家进频道；`/agent/stop` 请它离开，它已经在走也算成功。
- 凭据缺了返回带原因的 `VoiceUnavailable`，别的照常。

## 客户端

`app/lib/voice/`（`VoiceCall`）：从服务端取令牌，用 Agora 的 Flutter SDK 加入频道。Flutter 的 RTM 只有移动端，所以字幕、打断和语音管家的状态都走 RTC 的 data stream（`captions.dart` 拼块再解）。令牌快过期时换新的。只链语音要的 Agora 组件（`app/tool/agora-voice-only.sh`）。

语音里说的话只在客户端，不写进田头，帮工看不到。你说完一句，字幕定稿时交给农场派活（`POST /api/manager/hear`，管家只派活不回话）。

## 凭据

Agora 的 App ID 和 App Certificate 在首页「设置」或声音页里填，存在 `$VIBEVALLEY_HOME/settings.json`；也可以写进配置的 `agora.app_id`、`agora.app_certificate`，或者设环境变量 `AGORA_APP_ID`、`AGORA_APP_CERTIFICATE`。谁优先见 [server.md](server.md)「设置」。这些都不进仓库。

## 配置（`/voice`、`/manager/voice`）

语音设置存在 `settings.json` 的 `voice`，只存和默认不一样的（页面发整份，服务端存的时候自己去掉和默认一样的），下一通电话生效。页面上一边改一边问 `POST /api/settings/check`，说的就是保存时会被拒的理由。分两处改（[理由](../../.agents/notes/implemented/feature/2026-10-13-agent-pages-memory-and-voice.md)）：

- 工作台的「声音」（`/voice`）配**线路**：凭据和区域、怎么听（识别、语言、断句、打断）、用哪个大模型。
- 管家页的「声音」（`/manager/voice`）配**电话上的管家**：人设、开场白、出错时说的话、音色。

每一段可以用声网托管的，也可以换成自己的服务（微软 Azure、OpenAI 兼容的接口……），自己服务的 key 存在 `settings.json`，页面只看到最后四个字；缺 key 时开始通话就说缺哪个。字段在 `protocol/shapes.go`（`VoiceSettings`），默认在 `protocol/voice.go`（`DefaultVoice`），几个数的范围是 `shapes.go` 开头的共用常量，保存前的检查在 `setting/voice_rules.go`。MiniMax 音色的样音在 `app/assets/voice-samples/`，试听不连网。

## 语音线路（「想」选农场的管家时）

`server/internal/voice/line.go`：声网按 OpenAI Chat Completions 协议来问管家，管家的话边生成边以 SSE 流回去念。

- **只有这一个接口对外**：另开一个监听（配置的 `voice.line.port`，默认 8788，只听 127.0.0.1），上面只有 `POST /llm/<通话>/chat/completions`。端口被占时只记日志，农场照常。
- **隧道**：设了 `voice.line.url` 就用它；没设时第一通电话开一个 cloudflared 临时隧道，等它能应答（最多 60 秒），最后一通挂了 10 分钟后关掉。
- **每通电话一把钥匙**：声网的请求要带 `Authorization: Bearer <钥匙>`，挂了就作废。
- 只取最新的一句交给管家（`Manager.Call`），对话历史以管家自己的会话为准；声网打断时丢掉正在念的。
- 这时 `/api/manager/hear` 不再转给管家，免得一句话处理两次。
