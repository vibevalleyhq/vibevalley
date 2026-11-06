import { mossAudioTag, mossFrameSamples, mossTaggedFrameBytes } from "./protocol.ts";

/**
 * Microphone capture AudioWorkletProcessor ("vibevalley-moss-capture"):
 * - Runs at 16 kHz on the WebAudio rendering thread.
 * - Slices incoming Float32 samples into 320-sample (20 ms) frames.
 * - Computes RMS loudness (0..100) and packs the 641-byte `tagged-v1` binary frame directly on the audio thread.
 * - If connected to the transport Worker via `{ type: "connect", port }`, transfers `{ type: "mic_frame", frame, level }`
 *   straight to the Worker port without waking the UI main thread; otherwise posts raw PCM buffers to `this.port`.
 */
export const mossCaptureWorkletCode = `registerProcessor("vibevalley-moss-capture", class extends AudioWorkletProcessor {
  pcm = new Int16Array(${mossFrameSamples});
  at = 0;
  muted = false;
  peer = null;
  constructor() {
    super();
    this.port.onmessage = (e) => {
      const d = e.data;
      if (!d || typeof d !== "object") return;
      if (d.type === "mute") this.muted = Boolean(d.muted);
      else if (d.type === "connect" && d.port) this.peer = d.port;
    };
  }
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (!samples) return true;
    for (const s of samples) {
      const clamped = Math.max(-1, Math.min(1, s));
      this.pcm[this.at++] = clamped * 0x7fff;
      if (this.at === ${mossFrameSamples}) {
        if (this.peer) {
          let sum = 0;
          if (!this.muted) {
            for (let i = 0; i < ${mossFrameSamples}; i++) {
              const v = this.pcm[i] / 0x8000;
              sum += v * v;
            }
          }
          const level = this.muted ? 0 : Math.min(100, Math.round(Math.sqrt(sum / ${mossFrameSamples}) * 300));
          const frame = new Uint8Array(${mossTaggedFrameBytes});
          frame[0] = ${mossAudioTag};
          if (!this.muted) frame.set(new Uint8Array(this.pcm.buffer), 1);
          this.peer.postMessage({ type: "mic_frame", frame: frame.buffer, level }, [frame.buffer]);
          this.at = 0;
        } else {
          this.port.postMessage(this.pcm.buffer, [this.pcm.buffer]);
          this.pcm = new Int16Array(${mossFrameSamples});
          this.at = 0;
        }
      }
    }
    return true;
  }
});`;

/**
 * Speaker ring-buffer playback AudioWorkletProcessor ("vibevalley-moss-playback"):
 * - Runs at 48 kHz on the WebAudio rendering thread.
 * - Queues 16-bit PCM chunks sent from the transport Worker (or main thread) and converts Int16 -> Float32 in-place.
 * - Reports exact sample-accurate `chunk_ended` events and flushes immediately on `cut` with exact `partialMs` played.
 */
export const mossPlaybackWorkletCode = `registerProcessor("vibevalley-moss-playback", class extends AudioWorkletProcessor {
  queue = [];
  bufferedSamples = 0;
  peer = null;
  ticks = 0;
  lastLevel = 0;
  constructor() {
    super();
    const handle = (e) => {
      const d = e.data;
      if (!d || typeof d !== "object") return;
      if (d.type === "connect" && d.port) {
        this.peer = d.port;
        this.peer.onmessage = handle;
      } else if (d.type === "enqueue" && d.pcm instanceof ArrayBuffer) {
        const samples = new Int16Array(d.pcm, 0, Math.floor(d.pcm.byteLength / 2));
        this.queue.push({ chunk: d.chunk, run: d.run, turn: d.turn, samples, offset: 0 });
        this.bufferedSamples += samples.length;
      } else if (d.type === "cut") {
        let partialSamples = 0;
        const kept = [];
        for (const item of this.queue) {
          if (item.run === d.run) {
            partialSamples += item.offset;
            this.bufferedSamples -= (item.samples.length - item.offset);
          } else {
            kept.push(item);
          }
        }
        this.queue = kept;
        if (this.bufferedSamples < 0) this.bufferedSamples = 0;
        const partialMs = Math.round((partialSamples / sampleRate) * 1000);
        (this.peer || this.port).postMessage({ type: "cut_ack", run: d.run, turn: d.turn, partialMs });
      } else if (d.type === "clear") {
        this.queue = [];
        this.bufferedSamples = 0;
        this.lastLevel = 0;
      }
    };
    this.port.onmessage = handle;
  }
  process(_inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    const target = this.peer || this.port;
    let sumSq = 0;
    for (let i = 0; i < out.length; i++) {
      while (this.queue.length > 0 && this.queue[0].offset >= this.queue[0].samples.length) {
        const done = this.queue.shift();
        target.postMessage({
          type: "chunk_ended",
          chunk: done.chunk,
          run: done.run,
          turn: done.turn,
          aheadMs: Math.round((this.bufferedSamples / sampleRate) * 1000),
        });
      }
      if (this.queue.length === 0) {
        out[i] = 0;
      } else {
        const head = this.queue[0];
        const s = head.samples[head.offset++] / 0x8000;
        out[i] = s;
        sumSq += s * s;
        this.bufferedSamples--;
        if (head.offset >= head.samples.length) {
          this.queue.shift();
          target.postMessage({
            type: "chunk_ended",
            chunk: head.chunk,
            run: head.run,
            turn: head.turn,
            aheadMs: Math.round((this.bufferedSamples / sampleRate) * 1000),
          });
        }
      }
    }
    this.ticks++;
    if (this.ticks >= 15) {
      this.ticks = 0;
      const level = out.length > 0 ? Math.min(100, Math.round(Math.sqrt(sumSq / out.length) * 300)) : 0;
      if (level !== this.lastLevel || this.bufferedSamples > 0) {
        this.lastLevel = level;
        target.postMessage({
          type: "out_level",
          level,
          aheadMs: Math.round((this.bufferedSamples / sampleRate) * 1000),
        });
      }
    }
    return true;
  }
});`;
