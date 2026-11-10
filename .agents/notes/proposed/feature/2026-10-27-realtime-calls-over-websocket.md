# Agent Note: 自己的实时模型经本机 WebSocket 接电话，其余照旧走声网

Status: proposed

## Problem

当前语音通话（[语音](docs/subsystems/voice.md)）全部经声网 ConvoAI 建立，需要配置 Agora 凭据并在本机拉起 `8788` 语音线路与公网隧道（首次拨号需等待隧道就绪）。对于只在本机电脑前通话、已有 OpenAI Realtime 兼容接口密钥的用户：
- 实时模型由本机主动外连 WebSocket，工具调用沿同一连接返回，无需 Agora 凭据、独立监听端口或公网隧道。
- 当前 `apps/server/src/voice/voice.ts` 与前端 `apps/web/src/features/voice/call.ts` 将「农场单通电话状态机」与「声网供应商实现」写在一起，需先解耦传输层才能接入本机 WebSocket 实时通话。

## Proposal

### 1. 拆分通话状态机与传输通道

将服务端 `apps/server/src/voice/` 与前端 `apps/web/src/features/voice/` 按职责拆开：

| 层级 | 文件 | 职责 |
|---|---|---|
| 服务端通话协调 | `voice/voice.ts` | 单通电话状态、按设置选通道、通话内 `speak` 播报队列、挂断与游戏记账（面向统一 `OpenCall` 接口） |
| 声网通道 | `voice/agora.ts`、`line.ts` | Agora 令牌授予、ConvoAI 启停、512 字节切段播报、`8788` 语音线路与隧道 |
| 实时模型通道 | `voice/realtime.ts` | 外连 `wss://.../v1/realtime`、音频帧转发、插话截断、`ask_orchestrator` 工具执行与频道落库 |
| 前端通话层 | `features/voice/call.ts` | 统一暴露阶段、静音、音量与字幕；底层按 `agoraPath.ts` 与 `realtimePath.ts` 分流 |

### 2. 实时模型当嘴，农场事务调 `ask_orchestrator`

- **接听配置**：`VoiceAnswer` 新增 `{ vendor: "realtime"; url: string; model: string; voice: string }`，密钥存于 `settings.json` 的 `realtimeKey`（默认仍为声网管家模式）。
- **工具问管家**：日常寒暄由实时模型直接秒回；涉及工单、帮工、派活或记忆时，实时模型调用进程内工具 `ask_orchestrator` 将用户原话交 `Orchestrator`，再将管家回复口语化念出。
- **频道落库不重不漏**：用户输入转写定稿与模型自答经 `Channel.spoken` 记入默认频道（不重复唤醒）；`ask_orchestrator` 由管家写回频道，转述轮不再重复入库。
- **通话内主动播报与插话**：`Inbox.news` 事项经管家 `brief` 生成摘要后，在当前话音结束后发 `response.create` 播报；收到 `input_audio_buffer.speech_started` 时立即通知前端停播并按实际播放毫秒数发 `conversation.item.truncate`。

### 3. 本机 WebSocket 接口与安全边界

- 主监听 `8787` 新增 `GET /api/v1/voice/realtime` WebSocket 升级入口：严格校验同源 `Origin` 与回环 `Host`（非农场页面返回 `403`）。
- 仅限本机使用：「连接到本机」（`lan`）不转发该升级请求；远端设备在实时模型模式下拨号时返回 `VoiceUnavailable`。

## Alternatives considered

- **禁用实时模型自答，每句都等管家文字再交模型朗读**：首字需串联转写、管家推理与语音合成三段延迟，且实时模型朗读长文易改词。
- **浏览器直连外部厂商 WebRTC**：仅 OpenAI 支持，且工具调用与转写落库需绕经前端页面中转。
- **走声网 MLLM 模式**：仍需 Agora 凭据与公网回调入口，无法省去隧道。

## Acceptance criteria

- 仅配置实时模型地址、模型名与 `realtimeKey`（不填 Agora 凭据、不开 `8788` 线路与隧道）即可在桌面端拨通、对话并挂断。
- 询问农场状态或派工单时，实时模型调用 `ask_orchestrator` 执行并在默认频道留下唯一一份用户提问与管家回复。
- 插话时前端立即停播并按已播放毫秒数截断服务端上下文，外放通话 3 分钟不因回声自问自答；跨源连接 `/api/v1/voice/realtime` 返回 `403`。

## Risks

- 浏览器 AudioWorklet 播放非 WebRTC 音频时系统回声消除可能失效，实机验证若外放有回声，需在页面内建立本地回环 `RTCPeerConnection` 走浏览器 AEC 管线。
- 实时模型音频 token 费用较高，后续需接入 `runtime_spend` 表统一计入每日预算。
