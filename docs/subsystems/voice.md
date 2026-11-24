# 语音

实时通话的凭据、MOSS Live 线路与主助手语音旁白（`Voice::speak`）在 Rust 服务端的 `crates/server/src/collab/voice/`，接口是 `voice.*` 七个（`voice.hear`、`voice.moss.verify`、`voice.grant.create`、`voice.call.{start,stop,hear,say}`）。服务端不碰音频：连 MOSS Live 的 WebSocket、采集麦克风和播放回答，都是宿主（原生应用 `apps/mac`，和服务端同一个进程）的事。

## 在哪

| 位置 | 是什么 |
|---|---|
| `crates/server/src/transport/api/mod.rs` | `LiveVoicePort`、`LiveVoiceLine` 与 `SharedLiveVoice` 窄端口 trait：隔离开服务端具体 `Voice` 实现与桌面宿主 |
| `crates/server/src/collab/voice/mod.rs` | `Voice`（实现 `LiveVoicePort`）：凭据（`grant`，返回 `VoiceGrant { channel, uid }`）、通话（`start`、`stop`、`heard`、`said`、`speak`）、验 MOSS 的 Key（`verify_moss`），以及给宿主的 `moss_line`（实现 `LiveVoiceLine`） |
| `crates/server/src/collab/voice/moss.rs` | MOSS Live 的文字帧：`ask_orchestrator` 这个工具、会话设置、旁白（`commentary`）、验 Key |
| `crates/server/src/collab/voice/prompts.rs` | 通话里对模型说的话 |
| `crates/server/src/team/orchestrator/mod.rs` 的 `answer`、`brief` | 助手这一轮的话除了写进群聊，也通过窄端口交给等着它的那通电话（`Reply`） |
| `crates/server/src/infra/setting.rs` | `settings.json` 里的语音人设与开场白（`VoiceSettings { persona, greeting }`） |
| `apps/mac/src/live_voice.rs`、`apps/mac/src/audio.m` | 经 `Server::voice() -> Option<SharedLiveVoice>` 消费 `LiveVoicePort` 的原生 MOSS Live WebSocket 驱动与 AVAudioEngine 采集/播放（不导入 `vibevalley_server::<domain>::*`） |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`voice.*`）。

## 原生 MOSS 通话

`apps/mac/src/live_voice.rs` 持有 MOSS WebSocket，`audio.m` 用 AVAudioEngine 采集麦克风并转换为 16 kHz、单声道、16-bit PCM；每个 20 ms 包带 tagged-v1 标签，回答按 48 kHz 播放。音频设备只在握手接受 session 范围、无 delegation 的设置后打开。麦克风权限由打包应用的使用说明触发；开发二进制没有使用说明时明确拒绝，不冒险请求权限。

设置的语音页（`/settings/voice`）提供连接校验与开始、静音、挂断。页面以独立 owner ID 管一通电话；离开页面时撤回尚未回包的开始请求，迟到回包再次按同一 owner 挂断，不能关闭别的页面新开的通话。密钥只进入宿主的 Authorization 头，页面只见状态、拒绝和双方最后一句字幕。

- 启动与发包都有超时，挂断打断等待和正在发送的包；音频资源随连接退出释放。麦克风队列和播放队列各最多五秒，溢出结束本次通话，不自动重连或重试收费请求。
- 播放按 run、turn、chunk 对账，播完才回 `chunk.completed` 和 `playback.completed`。只接受一个在播放的 run；被打断的 run 留下墓碑，迟到音频和完成事件不会再次播放。打断时停掉未播部分，partial `played_audio_ms` 保守报 0，不估算仍在设备缓冲里的采样。
- 文件播放、Flash 与通话独占同一个输出租约；通话中其他播放请求明确拒绝。Flash 直接拉取服务端 `SpeechClaim`，满五秒时等待容量，停止可打断等待，末包播完才释放设备。
- 离线 WebSocket 与合成音频测试验证握手、标签帧、回执、打断和退出；真实 MOSS、麦克风权限与声学效果仍需在线验收。

## 一通电话

1. `voice.grant.create`：签发一份通话凭据 `VoiceGrant { channel, uid }`（未用时一小时过期，一份凭据只开一通电话）。
2. 宿主向 `Voice::moss_line()` 取 `MossLine`（含 MOSS Live 地址、Authorization Key 与会话配置），先发 `session_update()`（人设、开场白与 `ask_orchestrator` 工具）。
3. `voice.call.start { channel, uid, about? }`：登记活跃通话并回 `VoiceCall { agentId }`；`about` 是响铃缘由，用于替代默认问候语。
4. 通话里：宿主把 `outgoing` 里的帧原样发给 MOSS，把 MOSS 说的文字帧交给 `heard()`，并经 `voice.call.hear`（用户说的）和 `voice.call.say`（模型说的）记进默认频道（问候语不记）。`voice.hear` 是不带 `agentId` 的简化入口，只在恰好有一通电话时管用。模型调 `ask_orchestrator` 时服务端去问主助手并把回答放进 `outgoing`；服务端也可经 `Voice::speak` 注入旁白。
5. `voice.call.stop { agentId }`（或 `MossLine` 连接断开）：结束这通电话并释放活跃状态。

## 守住的

- **密钥不进页面**：MOSS 的 Key 只在服务端和宿主进程里；页面拿到的只有 `VoiceGrant { channel, uid }`。
- **主监听不上公网**：MOSS Live 由宿主直连出站 WebSocket，不开放公网回调端口或外部隧道。
- **凭据一次性**：未用上的凭据一小时后作废，一份凭据只开一通电话。
- **验 Key 不开会话**：`voice.moss.verify` 只带着 Key 问一次 MOSS 的实时地址，不采集也不发送音频。
- **测试离线**：验证与实时探针经 `Fetch` 与 `Realtime` trait 注入（`crates/server/tests/voice.rs`），全离线验证。

## 没做的

- 通话中有事等用户时主动播报（inbox news）：`Voice::speak` 已就绪，接上订阅即可使用。
- Vision 的相机与屏幕输入：原生通话目前只接 MOSS Live 音频。
