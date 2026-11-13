// Ported from VibeValley packages/engine/src/audio/synth.ts: the same pen
// (tone, noise, bell, seeded random) and recipes, rendered offline into a WAV
// file instead of scheduled on a WebAudio graph (nsh has no AudioContext).
// Each node follows the Web Audio spec: exponential ramps for the envelope
// and the glides, RBJ biquads (lowpass/highpass Q in dB, bandpass Q as is),
// a master gain into a soft limiter standing in for the DynamicsCompressor.

interface Shape {
  at?: number;
  dur: number;
  gain: number;
  attack?: number;
}

type Wave = "sine" | "square" | "sawtooth" | "triangle";
type Filter = "lowpass" | "highpass" | "bandpass";

interface ToneOptions extends Shape {
  freq: number;
  to?: number;
  type?: Wave;
  lowpass?: number;
}

interface NoiseOptions extends Shape {
  filter: Filter;
  freq: number;
  to?: number;
  q?: number;
}

interface BellOptions extends Shape {
  freq: number;
  partials?: readonly (readonly [number, number])[];
}

export interface Pen {
  tone(options: ToneOptions): void;
  noise(options: NoiseOptions): void;
  bell(options: BellOptions): void;
  random(): number;
}

export type Recipe = (pen: Pen) => void;

const RATE = 32_000;
const START = 0.005;

const BELL: readonly (readonly [number, number])[] = [
  [1, 1],
  [2.01, 0.42],
  [3.03, 0.18],
  [4.17, 0.09],
];

function seeded(seed: number) {
  let s = seed >>> 0;
  if (s === 0) s = 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10_000) / 10_000;
  };
}

/** setValueAtTime(0.0001) at t0, exponential ramp to the peak, exponential ramp back to 0.0001 at t0 + dur. */
function envelope(t: number, { dur, gain, attack = 0.005 }: Shape) {
  const a = Math.min(attack, dur * 0.5);
  const peak = Math.max(0.0002, gain);
  if (t < 0) return 0;
  if (t < a) return 0.0001 * (peak / 0.0001) ** (t / a);
  if (t < dur) return peak * (0.0001 / peak) ** ((t - a) / (dur - a));
  return 0.0001;
}

/** exponentialRampToValueAtTime from `from` to `to` over `dur`, then held. */
const glide = (from: number, to: number | undefined, t: number, dur: number) =>
  to == null || to === 0 ? from : t >= dur ? to : from * (to / from) ** (t / dur);

function wave(type: Wave, phase: number) {
  const p = phase - Math.floor(phase);
  switch (type) {
    case "sine":
      return Math.sin(2 * Math.PI * p);
    case "square":
      return p < 0.5 ? 1 : -1;
    case "sawtooth":
      return 2 * p - 1;
    case "triangle":
      return 1 - 4 * Math.abs(p - 0.5);
  }
}

/** A biquad whose coefficients follow its frequency, as the Web Audio spec computes them. */
function biquad(type: Filter, q: number) {
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x: number, freq: number) => {
    const w0 = (2 * Math.PI * Math.min(freq, RATE / 2 - 1)) / RATE;
    const cos = Math.cos(w0);
    const sin = Math.sin(w0);
    const alpha = type === "bandpass" ? sin / (2 * q) : sin / (2 * 10 ** (q / 20));
    let b0: number;
    let b1: number;
    let b2: number;
    if (type === "lowpass") {
      b1 = 1 - cos;
      b0 = b1 / 2;
      b2 = b0;
    } else if (type === "highpass") {
      b1 = -(1 + cos);
      b0 = (1 + cos) / 2;
      b2 = b0;
    } else {
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
    }
    const a0 = 1 + alpha;
    const a1 = -2 * cos;
    const a2 = 1 - alpha;
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

/** Renders `recipe` as mono samples (master gain and limiter applied). */
export function render(recipe: Recipe, { seed = 1, volume = 0.55 } = {}): Float32Array {
  const voices: ((out: Float32Array) => void)[] = [];
  let end = 0;
  const pen: Pen = {
    tone({ freq, to, type = "sine", lowpass, ...shape }) {
      const t0 = START + (shape.at ?? 0);
      const stop = t0 + shape.dur + 0.05;
      end = Math.max(end, stop);
      voices.push((out) => {
        const filter = lowpass != null && lowpass !== 0 ? biquad("lowpass", 1) : undefined;
        let phase = 0;
        const from = Math.floor(t0 * RATE);
        for (let i = from; i < Math.min(out.length, Math.floor(stop * RATE)); i++) {
          const t = i / RATE - t0;
          phase += glide(freq, to, t, shape.dur) / RATE;
          const s = wave(type, phase);
          out[i] = (out[i] ?? 0) + (filter ? filter(s, lowpass ?? 0) : s) * envelope(t, shape);
        }
      });
    },
    noise({ filter, freq, to, q = 1, ...shape }) {
      const t0 = START + (shape.at ?? 0);
      const stop = t0 + shape.dur + 0.05;
      end = Math.max(end, stop);
      // The same draw order as the original: a noise takes one random number for its buffer offset.
      pen.random();
      voices.push((out) => {
        const f = biquad(filter, q);
        for (let i = Math.floor(t0 * RATE); i < Math.min(out.length, Math.floor(stop * RATE)); i++) {
          const t = i / RATE - t0;
          out[i] = (out[i] ?? 0) + f(Math.random() * 2 - 1, glide(freq, to, t, shape.dur)) * envelope(t, shape);
        }
      });
    },
    bell({ freq, partials = BELL, ...shape }) {
      for (const [ratio, weight] of partials) {
        pen.tone({ ...shape, freq: freq * ratio, gain: shape.gain * weight, dur: shape.dur / Math.sqrt(ratio), attack: 0.002 });
      }
    },
    random: seeded(seed),
  };
  recipe(pen);
  const out = new Float32Array(Math.ceil((end + 0.02) * RATE));
  for (const v of voices) v(out);
  // The original's limiter (threshold -10 dB, ratio 6, attack 3 ms, release 120 ms) on a peak follower.
  const threshold = 10 ** (-10 / 20);
  const attack = Math.exp(-1 / (0.003 * RATE));
  const release = Math.exp(-1 / (0.12 * RATE));
  let level = 0;
  for (let i = 0; i < out.length; i++) {
    const x = (out[i] ?? 0) * volume;
    const a = Math.abs(x);
    level = a > level ? attack * level + (1 - attack) * a : release * level + (1 - release) * a;
    const over = level > threshold ? (threshold * (level / threshold) ** (1 / 6)) / level : 1;
    out[i] = Math.max(-1, Math.min(1, x * over));
  }
  return out;
}

/** 16-bit mono PCM WAV bytes of `samples`. */
export function wav(samples: Float32Array): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, RATE, true);
  view.setUint32(28, RATE * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, Math.round((samples[i] ?? 0) * 0x7fff), true);
  return bytes;
}

export function base64(bytes: Uint8Array): string {
  const pieces: string[] = [];
  for (let i = 0; i < bytes.length; i += 0x8000) pieces.push(String.fromCharCode(...bytes.subarray(i, i + 0x8000)));
  return btoa(pieces.join(""));
}
