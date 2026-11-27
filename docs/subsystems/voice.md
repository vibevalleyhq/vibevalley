# 语音

实时通话与语音听写（ASR）的凭据、MOSS Live 线路与主助手语音旁白（`Voice::speak`）在 Rust 服务端的 `crates/server/src/voice/`。桌面原生通话与听写经进程内窄端口 `Server::voice()`（`LiveVoicePort`）直接驱动；对外仅保留 `voice.moss.verify` 一个校验密钥的 RPC 接口。服务端不碰音频设备：连 MOSS Live 的 WebSocket、采集麦克风和播放回答，都是宿主（原生应用 `apps/mac`，和服务端同一个进程）的事。

## 在哪

| 位置 | 是什么 |
|---|---|
| `crates/server/src/context/api.rs` | `LiveVoicePort`、`LiveVoiceLine` 与 `SharedLiveVoice` 窄端口 trait：隔离开服务端具体 `Voice` 实现与桌面宿主（含 `grant`、`start`、`stop`、`heard`、`said`、`moss_line`、`asr_line`、`can_transcribe`、`transcribe_wav_async`、`polish_transcript_async`） |
| `crates/server/src/voice/` | `Voice`（实现 `LiveVoicePort`）：通话凭据与会话（`grant`、`start`、`stop`、`heard_async`、`said_async`、`speak`）、ASR 听写与转写（`asr_line`、`transcribe_wav_async`、`polish_transcript_async`）、验 MOSS 的 Key（`verify_moss_async`） |
| `crates/server/src/voice/moss.rs` | MOSS Live 文字帧（`ask_orchestrator` 工具、通话与听写 `session_update`、旁白、验 Key）与批量 WAV 转写（`HttpTranscriber`） |
| `crates/server/src/voice/prompt.rs` | 通话与听写里对模型说的话 |
| `crates/server/src/agent/orchestrator/mod.rs` 的 `answer`、`brief` | 助手这一轮的话除了写进群聊，也通过窄端口交给等着它的那通电话（`Reply`） |
| `crates/server/src/setting.rs` | `settings.json` 里的语音人设与开场白（`VoiceSettings { persona, greeting }`） |
| `apps/mac/src/live_voice.rs`、`apps/mac/src/voice_asr.rs`、`apps/mac/src/audio.{rs,m}` | 经 `Server::voice() -> Option<SharedLiveVoice>` 消费 `LiveVoicePort` 的原生 MOSS Live 通话与 Composer ASR 听写驱动、独立麦克风采集/扬声器输出租约与实时电平归一化 |
| `apps/mac/ui/features/voice/` | 「语音与通话」设置页（`NativeCall`、`VoiceOrb`、`MicWaveform` 与内联 MOSS 密钥/模型配置） |
| `apps/mac/ui/features/channel/views/Composer.tsx` | 频道与工单评论共用的输入框一键听写按钮（`host.asrStart`/`asrState`/`asrStop`） |

接口清单见 [capabilities.md](docs/reference/capabilities.md)（`voice.*`）。

## 原生 MOSS 通话

`apps/mac/src/live_voice.rs` 持有 MOSS WebSocket，`audio.m` 用 AVAudioEngine 采集麦克风并转换为 16 kHz、单声道、16-bit PCM；每个 20 ms 包带 tagged-v1 标签，回答按 48 kHz 播放。音频设备只在握手接受 session 范围、无 delegation 的设置后打开。麦克风权限由打包应用的使用说明触发；开发二进制没有使用说明时明确拒绝，不冒险请求权限。

设置的语音页（`/settings/voice`）提供连接校验与开始、静音、挂断。页面以独立 owner ID 管一通电话；离开页面时撤回尚未回包的开始请求，迟到回包再次按同一 owner 挂断，不能关闭别的页面新开的通话。密钥只进入宿主的 Authorization 头，页面只见状态、拒绝和双方最后一句字幕。

- 启动与发包都有超时，挂断打断等待和正在发送的包；音频资源随连接退出释放。麦克风队列和播放队列各最多五秒，溢出结束本次通话，不自动重连或重试收费请求。
- 播放按 run、turn、chunk 对账，播完才回 `chunk.completed` 和 `playback.completed`。只接受一个在播放的 run；被打断的 run 留下墓碑，迟到音频和完成事件不会再次播放。打断时停掉未播部分，partial `played_audio_ms` 保守报 0，不估算仍在设备缓冲里的采样。
- 文件播放、Flash 语音播放独占输出租约（`reserve_output`），Composer ASR 听写独占采集租约（`reserve_capture`），MOSS Live 通话同时持有采集与输出租约（`reserve_for_call`）。因此语音播报不会打断听写，通话中其他播放或听写请求明确拒绝，互不抢占设备。
- 设置页「语音与通话」（`/settings/voice`）提供呼吸灯 `VoiceOrb` 与实时 `MicWaveform` 波形（跟随 Light/Dark 语义令牌并遵守 `reduceMotion`），并内置 Live/Speech/Transcription 模型选择与 API Key 配置。
- 频道对话与工单评论共用的 `Composer` 提供一键语音输入按钮，优先直连 MOSS Live 实时返回 `input.transcript.delta`/`done`（无 Live 绑定时回退到 `Use::Transcription` 批量 WAV 转写）。
- 离线 WebSocket 与合成音频测试验证握手、标签帧、回执、打断和退出；真实 MOSS、麦克风权限与声学效果仍需在线验收。

## 一通电话

1. `LiveVoicePort::grant()`：签发一份通话凭据 `VoiceGrant { channel, uid }`（未用时一小时过期，一份凭据只开一通电话）。
2. 宿主向 `LiveVoicePort::moss_line()` 取 `LiveVoiceLine`（含 MOSS Live 地址、Authorization Key 与会话配置），先发 `session_update()`（人设、开场白与 `ask_orchestrator` 工具）。
3. `LiveVoicePort::start(channel, uid)`：登记活跃通话并回 `VoiceCall { agentId }`（`Voice::start` 另支持传入响铃缘由 `about`，替代默认问候语）。
4. 通话里：宿主把 `outgoing` 里的帧原样发给 MOSS，把 MOSS 说的文字帧交给 `heard()`，并经 `LiveVoicePort::heard`（用户说的）和 `LiveVoicePort::said`（模型说的）记进默认频道（问候语不记）。模型调 `ask_orchestrator` 时服务端去问主助手并把回答放进 `outgoing`；服务端也可经 `Voice::speak` 注入旁白。
5. `LiveVoicePort::stop(agent_id)`（或 `MossLine` 连接断开）：结束这通电话并释放活跃状态。

## 守住的

- **密钥不进页面**：MOSS 的 Key 只在服务端和宿主进程里；页面拿到的只有 `VoiceGrant { channel, uid }`。
- **主监听不上公网**：MOSS Live 由宿主直连出站 WebSocket，不开放公网回调端口或外部隧道。
- **凭据一次性**：未用上的凭据一小时后作废，一份凭据只开一通电话。
- **验 Key 不开会话**：`voice.moss.verify` 只带着 Key 问一次 MOSS 的实时地址，不采集也不发送音频。
- **测试离线**：验证与实时探针经 `Fetch` 与 `Realtime` trait 注入（`crates/server/tests/voice.rs`），全离线验证。

## 没做的

- 通话中有事等用户时主动播报（inbox news）：`Voice::speak` 已就绪，接上订阅即可使用。
- Vision 的相机与屏幕输入：原生通话目前只接 MOSS Live 音频。
