# `@vibevalley/voice`

统一的实时语音与音频转写包，供 `apps/server` 与 `apps/web` 消费，内部严格按 **`core/`（核心契约）+ `moss/` + `agora/` + `transcribe/`** 四大子域隔离，与农场业务状态解耦：

- `./core`（`src/core/contract.ts`）：零厂商耦合的核心契约层，定义统一实时通话会话接口 `VoiceDriver`、通话阶段 `VoicePhase`、双向字幕轮次 `VoiceTurn`、纯轮次合并函数 `appendVoiceTurn`，以及跨端通用的 `pcm16RmsLevel` / `float32RmsLevel` 音量计算。
- `./moss` & `./moss-server`（`src/moss/`）：实现 `VoiceDriver` 核心契约的 MOSS Live 实时双向语音子域：
  - `moss/protocol.ts`：纯协议 Schema（`MossFrameSchema`）、`tagged-v1` 二进制封包拆包（`packTaggedAudio`、`unpackPcm16`）与 QoS 结构。
  - `moss/playback.ts`：纯输出播放队列与采样级打断对账状态机（`Playback`）。
  - `moss/worklets.ts`：独立音频渲染线程的双 `AudioWorkletProcessor`（16kHz 采集封包 `mossCaptureWorkletCode` + 48kHz 环形缓冲播放 `mossPlaybackWorkletCode`）。
  - `moss/engine.ts`：零 DOM 依赖的纯事件驱动会话与协议状态机（`MossEngine`）。
  - `moss/worker.ts`：独立 `Web Worker` 传输桥（`openMossRelayBridge`），通过 `MessageChannel` 直连两个 `AudioWorklet`，让上下行高频 PCM 二进制流完全绕过 UI 主线程。
  - `moss/line.ts`：实现 `VoiceDriver` 的浏览器端薄反应式控制器（`MossLine`）。
  - `moss/server.ts`：服务端握手鉴权探测（`verifyMoss`）与双向 WebSocket 帧中继（`relay`）。
- `./agora` & `./captions`（`src/agora/`）：实现 `VoiceDriver` 契约的声网子域：
  - `agora/server.ts`：声网 ConvoAI 与 RTC Token 签发、ASR/LLM/TTS 厂商装配（`buildVendors`）、512 字节内分句播报切分（`speakPieces`）与 Clock 感知重试（`retrying`）。
  - `agora/captions.ts`：声网 RTC 数据流分片重组、实时字幕状态机（`LiveCaptions`、`liveCaptions`）及向核心 `VoiceTurn` 映射的 `voiceTurnsOfCaptions`。
- `./transcribe`（`src/transcribe/transcribe.ts`）：16kHz 单声道 WAV 编码（`wavOf`、`encodeWavBase64`）、麦克风采样 Worklet、听写文本光标插入（`insertDictated`），以及服务端 `/audio/transcriptions` 强 Schema 校验转写客户端（`transcribeAudio`）。
