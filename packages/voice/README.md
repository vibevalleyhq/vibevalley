# `@vibevalley/voice`

语音协议、音频转写与实时通话引擎包，供 `apps/server` 与 `apps/web` 消费，与农场业务状态解耦：

- `./transcribe`：16kHz 单声道 WAV 编码（`wavOf`、`encodeWavBase64`）、麦克风采样 Worklet、听写文本光标插入（`insertDictated`），以及服务端 `/audio/transcriptions`（MOSS / OpenAI 兼容）强 Schema 校验转写客户端（`transcribeAudio`）。
- `./moss`：按四层清晰边界组织的 MOSS Live 实时双向语音内核：
  - `moss/protocol.ts`：纯协议 Schema（`MossFrameSchema`）、`tagged-v1` 二进制音频封包拆包（`packTaggedAudio`、`unpackPcm16`）、字幕轮次合并（`heard`）、音量计算（`levelOf`）与 QoS 结构。
  - `moss/playback.ts`：纯输出播放队列与采样级打断对账状态机（`Playback`）。
  - `moss/worklets.ts`：运行在独立音频渲染线程的双 `AudioWorkletProcessor`——`mossCaptureWorkletCode`（16kHz 320 采样切片 + RMS 音量 + 641 字节 `tagged-v1` 封包）与 `mossPlaybackWorkletCode`（48kHz 环形缓冲播放 + 采样级 `chunk_ended` 与瞬时打断清空）。
  - `moss/engine.ts`：零 DOM 依赖的纯事件驱动会话与协议状态机（`MossEngine`）。
  - `moss/worker.ts`：独立 `Web Worker` 传输桥（`mossRelayWorkerCode`、`openMossRelayBridge`），通过 `MessageChannel` 直连两个 `AudioWorklet`，让上下行高频 PCM 二进制流完全绕过 UI 主线程。
  - `moss/line.ts`：供前端页面直接订阅的薄反应式控制器（`MossLine`）。
- `./moss-server`：MOSS Live 服务端握手鉴权探测（`verifyMoss`）与双向 WebSocket 帧中继（`relay`）。
- `./captions`：声网 RTC 数据流分片重组与实时字幕状态机（`LiveCaptions`、`liveCaptions`）。
- `./agora`：声网 ConvoAI 与 RTC Token 签发、ASR/LLM/TTS 厂商装配（`vendorsFor`）、512 字节内分句播报切分（`speakPieces`）与 Clock 感知重试（`retrying`）。
