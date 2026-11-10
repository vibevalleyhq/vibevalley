# Agent Note: 通用 OpenAI Realtime 模型经本机 WebSocket 接电话与通话通道拆分

Status: proposed

## Problem

MOSS Live 已打通经本机 WebSocket（`/api/v1/voice/moss/line`）免声网凭据与隧道接听农场电话（[语音](docs/subsystems/voice.md)），但还剩两处待补齐：
- 已有 OpenAI Realtime 兼容接口密钥的用户尚不能用通用 `wss://.../v1/realtime` 模型接听电话。
- `apps/server/src/voice/voice.ts` 与前端 `apps/web/src/features/voice/call.ts` 仍按 `agora` / `moss` 分支内联编排，需抽出统一通话通道接口再接入第三种实时协议。

## Proposal

1. **拆分通话协调与传输通道**：`voice/voice.ts` 与前端 `features/voice/call.ts` 面向统一 `OpenCall` 通道接口管理单通状态、静音、字幕与 `Inbox.news` 播报队列；声网（`agora.ts`、`line.ts`）、MOSS（`moss-relay.ts`）与 OpenAI Realtime（`realtime.ts`）各自实现传输层。
2. **接入通用 OpenAI Realtime（`vendor: "realtime"`）**：
   - `VoiceAnswer` 增加 `{ vendor: "realtime"; url: string; model: string; voice: string }`，主监听 `8787` 提供仅限本机同源回环升级的 `GET /api/v1/voice/realtime`（`lan` 不转发）。
   - 复用与 MOSS 通话一致的 `ask_orchestrator` 工具注入与 `quick` 字幕落库；收到 `input_audio_buffer.speech_started` 时立即通知前端停播并按已播放毫秒数发 `conversation.item.truncate`。

## Alternatives considered

- **浏览器直连外部厂商 WebRTC**：仅 OpenAI 支持，且工具调用与转写落库需绕经前端中转。
- **走声网 MLLM 模式**：仍需 Agora 凭据与公网回调隧道。

## Acceptance criteria

- 仅配置 OpenAI Realtime 地址、模型名与密钥（无 Agora 凭据、不开 `8788` 隧道）即可在桌面端拨通、调 `ask_orchestrator` 派单并挂断。
- 插话时前端立即停播并按已播放毫秒数截断服务端上下文；跨源或经 `lan` 连接 `/api/v1/voice/realtime` 被拒绝。

## Risks

- 非 WebRTC AudioWorklet 外放若在实机出现回声，需在页面内经本地回环 `RTCPeerConnection` 接入浏览器回声消除管线。
