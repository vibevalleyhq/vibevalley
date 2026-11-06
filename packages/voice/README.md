# `@vibevalley/voice`

语音协议、音频转写与实时通话引擎包，供 `apps/server` 与 `apps/web` 消费，与农场业务状态解耦：

- `./transcribe`：16kHz 单声道 WAV 编码（`wavOf`、`encodeWavBase64`）、麦克风采样 Worklet、听写文本光标插入（`insertDictated`），以及服务端 `/audio/transcriptions`（MOSS / OpenAI 兼容）强 Schema 校验转写客户端（`transcribeAudio`）。
- `./moss`：MOSS Live 实时双向语音协议帧 Schema（`MossFrameSchema`）、轮次文本合并（`heard`）、输出时钟与打断队列（`Playback`）、PCM 音量计算（`levelOf`）及浏览器端 `MossSession` 实时会话控制器。
- `./moss-server`：MOSS Live 服务端握手鉴权探测（`verifyMoss`）与双向 WebSocket 帧中继（`relay`）。
- `./captions`：声网 RTC 数据流分片重组与实时字幕状态机（`LiveCaptions`、`liveCaptions`）。
- `./agora`：声网 ConvoAI 与 RTC Token 签发、ASR/LLM/TTS 厂商装配（`vendorsFor`）、512 字节内分句播报切分（`speakPieces`）与 Clock 感知重试（`retrying`）。
