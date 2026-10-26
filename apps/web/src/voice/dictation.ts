// Dictation: tap to talk, tap again to stop; the recording goes to the server
// (voice.dictate), which hands it to the transcription address in 声音's 听写, and the words come back for the field it
// was started from. Recorded as 16 kHz mono WAV, which every transcriber takes. One recording at a time.

import { api, reasonOf } from "../data/api";

export type DictationPhase = "idle" | "recording" | "transcribing";

const rate = 16000;

// An AudioWorklet's module, as a script of its own: it hands the microphone's samples on in runs of 4096, so the page
// is not woken every 128.
const capture = `registerProcessor("vibevalley-capture", class extends AudioWorkletProcessor {
  run = new Float32Array(4096);
  at = 0;
  process(inputs) {
    const samples = inputs[0]?.[0];
    if (samples)
      for (const s of samples) {
        this.run[this.at++] = s;
        if (this.at === this.run.length) {
          this.port.postMessage(this.run);
          this.run = new Float32Array(4096);
          this.at = 0;
        }
      }
    return true;
  }
});`;
let captureUrl: string | undefined;

/** Mono 16-bit PCM in a WAV file. */
export function wavOf(samples: Float32Array, sampleRate = rate): Uint8Array {
  const out = new DataView(new ArrayBuffer(44 + samples.length * 2));
  const text = (at: number, s: string) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  out.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, sampleRate, true);
  out.setUint32(28, sampleRate * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  text(36, "data");
  out.setUint32(40, samples.length * 2, true);
  samples.forEach((s, i) => out.setInt16(44 + i * 2, Math.max(-1, Math.min(1, s)) * 0x7fff, true));
  return new Uint8Array(out.buffer);
}

const base64Of = (bytes: Uint8Array) => {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

interface Recording {
  readonly stream: MediaStream;
  readonly context: AudioContext;
  readonly node: AudioWorkletNode;
  readonly chunks: Float32Array[];
  readonly onWords: (words: string) => void;
}

export class Dictation {
  phase: DictationPhase = "idle";
  problem?: string;
  version = 0;
  private recording?: Recording;
  /** The field it was started from: the words go there, or nowhere once it is gone. */
  private owner?: object;
  private readonly listeners = new Set<() => void>();

  subscribe = (f: () => void) => {
    this.listeners.add(f);
    return () => this.listeners.delete(f);
  };

  private set(phase: DictationPhase, problem?: string | null) {
    this.phase = phase;
    if (problem !== undefined) this.problem = problem ?? undefined;
    this.version++;
    for (const f of this.listeners) f();
  }

  /** Starts for `owner`, or stops and transcribes when it is recording; a second field may stop it, not take it over. */
  async toggle(owner: object, onWords: (words: string) => void) {
    if (this.phase === "transcribing") return;
    if (this.phase === "recording") return this.finish();
    this.owner = owner;
    this.set("recording", null);
    let stream: MediaStream | undefined;
    let context: AudioContext | undefined;
    const drop = () => {
      stream?.getTracks().forEach((t) => t.stop());
      void context?.close();
    };
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      context = new AudioContext({ sampleRate: rate });
      await context.audioWorklet.addModule((captureUrl ??= URL.createObjectURL(new Blob([capture], { type: "text/javascript" }))));
      // After every wait: the field may have been released, or another may have stopped it, meanwhile.
      if (this.owner !== owner) return drop();
      const node = new AudioWorkletNode(context, "vibevalley-capture", { channelCount: 1 });
      const chunks: Float32Array[] = [];
      node.port.onmessage = (e: MessageEvent<Float32Array>) => chunks.push(e.data);
      context.createMediaStreamSource(stream).connect(node);
      // Connected on to the output (it writes silence there), as a node nobody pulls may not be run.
      node.connect(context.destination);
      this.recording = { stream, context, node, chunks, onWords };
    } catch (e) {
      drop();
      this.owner = undefined;
      this.set("idle", e instanceof Error && e.name === "NotAllowedError" ? "录不了音：没有麦克风权限" : `录不了音：${reasonOf(e)}`);
    }
  }

  /** The field it was started for is gone: what it hears goes nowhere. */
  release(owner: object) {
    if (this.owner !== owner) return;
    this.owner = undefined;
    this.close();
    this.set("idle");
  }

  private close() {
    const r = this.recording;
    this.recording = undefined;
    if (!r) return;
    r.node.disconnect();
    r.stream.getTracks().forEach((t) => t.stop());
    void r.context.close();
  }

  private async finish() {
    const r = this.recording;
    const owner = this.owner;
    this.close();
    if (!r) return this.set("idle");
    this.set("transcribing");
    try {
      const all = new Float32Array(r.chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of r.chunks) {
        all.set(c, at);
        at += c.length;
      }
      if (all.length === 0) throw new Error("没录上");
      const said = await api.voice.dictate({ body: { audio: base64Of(wavOf(all)), format: "wav" } });
      if (this.owner === owner && said.text) r.onWords(said.text);
      this.set("idle", null);
    } catch (e) {
      this.set("idle", reasonOf(e));
    } finally {
      if (this.owner === owner) this.owner = undefined;
    }
  }
}

/** The page's one recorder. */
export const dictation = new Dictation();

/** Dictated words at the caret, or at the end: a space only between two Latin words, as Chinese runs on without one. */
export function insertDictated(value: string, start: number, end: number, words: string) {
  const before = value.slice(0, start);
  const ascii = /[A-Za-z0-9]/;
  const gap = before && ascii.test(before.at(-1)!) && ascii.test(words[0] ?? "") ? " " : "";
  const inserted = gap + words;
  return { value: before + inserted + value.slice(end), caret: start + inserted.length };
}
