# 语音

听写、通话的凭据、通话本身，在 Rust 服务端的 `crates/server/src/modules/collab/voice/`，接口是 `voice.*` 九个。服务端不碰音频：进声网的 RTC 频道、连 MOSS Live 的 socket、采集和播放，都是宿主（原生应用，和服务端同一个进程）的事。

## 在哪

| 位置 | 是什么 |
|---|---|
| `voice/mod.rs` | `Voice`：凭据（`grant`、`renew`）、通话（`start`、`stop`、`heard`、`said`、`speak`）、听写、验 MOSS 的 Key，和给宿主的 `moss_line` |
| `voice/token.rs` | 声网的 AccessToken2（RTC 加 RTM）：给客户端的凭据、帮它接话的 agent 的令牌、每次 REST 调用的 `Authorization` 都是它 |
| `voice/agora.rs` | 声网 Conversational AI 的 REST：按语音设置拼出 join 的请求（三家厂商和各自的 preset），speak、leave，408、429、5xx 再试两次 |
| `voice/line.rs` | 语音线路：只听 127.0.0.1、只有一个接口 `POST /llm/<id>/chat/completions`、每通电话一把钥匙的监听，和通到它的隧道（cloudflared，或 `VIBEVALLEY_VOICE_LINE_URL`） |
| `voice/moss.rs` | MOSS Live 的文字帧：`ask_orchestrator` 这个工具、会话设置、旁白、验 Key |
| `voice/dictation.rs` | 听写：检查录音，发到 OpenAI 形状的 `/audio/transcriptions`（默认 MOSS，或用户自己的地址） |
| `voice/prompts.rs` | 通话里对模型说的话 |
| `modules/team/orchestrator/mod.rs` 的 `answer`、`brief` | 助手这一轮的话除了写进群聊，也交给等着它的那通电话（`Reply`） |
| `modules/infra/setting.rs` | `settings.json` 里的语音设置、声网凭据和各家的 Key |

## 原生 MOSS 通话

`apps/mac/src/live_voice.rs` 持有 MOSS WebSocket，`audio.m` 用 AVAudioEngine 采集麦克风并转换为 16 kHz、单声道、16-bit PCM；每个 20 ms 包带 tagged-v1 标签，回答按 48 kHz 播放。音频设备只在握手接受 session 范围、无 delegation 的设置后打开。麦克风权限由打包应用的使用说明触发；开发二进制没有使用说明时明确拒绝，不冒险请求权限。

设置的 MOSS 页提供开始、静音与挂断。页面以独立 owner ID 管一通电话；离开页面时撤回尚未回包的开始请求，迟到回包再次按同一 owner 挂断，不能关闭别的页面新开的通话。密钥只进入宿主的 Authorization 头，页面只见状态、拒绝和双方最后一句字幕。

- 启动与发包都有超时，挂断打断等待和正在发送的包；音频资源随连接退出释放。麦克风队列和播放队列各最多五秒，溢出结束本次通话，不自动重连或重试收费请求。
- 播放按 run、turn、chunk 对账，播完才回 chunk.completed 和 playback.completed。只接受一个在播放的 run；被打断的 run 留下墓碑，迟到音频和完成事件不会再次播放。打断时停掉未播部分，partial played_audio_ms 保守报 0，不估算仍在设备缓冲里的采样。
- 文件播放、Flash 与通话独占同一个输出租约；通话中其他播放请求明确拒绝。Flash 直接拉取服务端 SpeechClaim，满五秒时等待容量，停止可打断等待，末包播完才释放设备。
- 离线 WebSocket 与合成音频测试验证握手、标签帧、回执、打断和退出；真实 MOSS、麦克风权限与声学效果仍需在线验收。

## 一通电话

1. `voice.grant.create`：按语音设置里「想」的那一家，发一份凭据。声网：`{ appId, channel, uid, token }`，`token` 一小时；MOSS：`appId` 和 `token` 都是 `"moss"`，只用来认这通电话。
2. 宿主拿凭据进频道（声网），或向 `Voice::moss_line()` 要线路（MOSS）。
3. `voice.call.start { channel, uid, about? }`：声网这边请 agent 进同一个频道，只听这个 `uid`；回 `agentId`。`about` 是响铃的缘由：不说问候语，助手先开口说它。
4. 通话里：自带模型接话的电话（声网托管的模型、DeepSeek、自己的模型、MOSS），宿主把字幕经 `voice.call.hear`（用户说的）和 `voice.call.say`（模型说的）交回来，记进群聊，标成说出来的话；问候语不记。助手接话的电话走语音线路，两边的话线路上已经记了，`hear` 不再记一遍。`voice.hear` 是不带 `agentId` 的 `hear`，只在恰好有一通电话时管用。
5. 凭据快过期时 `voice.grant.renew { channel, uid }`，用发凭据时的那份声网凭据重签。
6. `voice.call.stop { agentId }`：请 agent 离开，收回这通电话的线路钥匙。

助手接话（默认）时，声网的云要能找到助手：服务端在第一通电话时开语音线路和隧道，把这通电话自己的地址和钥匙写进 join 请求的 `llm`；声网每听完一句，就照 OpenAI 的格式问一次，用户的话进群聊，助手这一轮的话流回去。

MOSS Live 的电话没有声网：宿主照 `MossLine` 给的地址和 Key 连上 MOSS，先发 `session_update()`（人设、开场和工具），把 `outgoing` 里的帧原样发出去，把 MOSS 说的每个文字帧交给 `heard()`。模型调 `ask_orchestrator` 时服务端去问助手，把回答放进 `outgoing`。`MossLine` 丢掉（socket 断了），这通电话就结束。

## 守住的

- **密钥不进页面**：声网的 App Certificate、各家的 Key、MOSS 的 Key 都只在服务端和宿主进程里；页面拿到的只有这通电话的凭据。
- **主监听不上公网**：隧道只通到语音线路的端口；线路只认路径上的电话号和它的钥匙，其余一律 401 或 404。
- **凭据跟着电话**：发凭据时的声网凭据一直用到这通电话结束，中途改设置不影响它；没用上的凭据一小时后作废，一份凭据只开一通电话。
- **验 Key 不开会话**：`voice.moss.verify` 只带着 Key 问一次 MOSS 的实时地址，不采集也不发送音频。
- **测试离线**：厂商经 `Fetch` 注入，隧道和重试的等待也能换掉（`crates/server/tests/voice.rs`）；令牌对着 `agora-token` 算出的值，join 请求对着 `tests/fixtures/voice-requests.json` 里 SDK 发过的请求。

## 没做的

- 通话中有事等用户时主动播报（TS 的 inbox news）：Rust 的 watch 还没有这条消息流。`Voice::speak` 在，接上就能用。
- Vision 的相机与屏幕输入：原生通话只接 MOSS Live 音频，不接声网原生 SDK。
- 隧道在最后一通电话之后留十分钟再关：现在开了就留到服务端退出。
