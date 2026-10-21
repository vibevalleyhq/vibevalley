// A tiny synthesizer for game sound effects: tones, filtered noise and bells, shaped by envelopes and
// scheduled on the audio clock. No audio files. A game writes its sounds as recipes; play() runs one.

/** One envelope: silent → peak in `attack` → silent again at the end. */
interface Shape {
  /** Seconds after the sound starts. */
  at?: number;
  dur: number;
  /** Peak level of the envelope. Filtering throws most of the noise away, so narrow noise bands need more than 1. */
  gain: number;
  attack?: number;
}

export interface ToneOptions extends Shape {
  freq: number;
  /** Glide to this frequency over the duration. */
  to?: number;
  type?: OscillatorType;
  /** Through a lowpass at this frequency, for softer edges. */
  lowpass?: number;
}

export interface NoiseOptions extends Shape {
  filter: BiquadFilterType;
  freq: number;
  /** Sweep the filter to this frequency over the duration. */
  to?: number;
  q?: number;
}

export interface BellOptions extends Shape {
  freq: number;
  /** Overtones as [ratio to freq, relative gain]. The default is a small, bright bell. */
  partials?: readonly (readonly [number, number])[];
}

/** What a recipe draws with. Every call schedules relative to the moment the sound was played. */
export interface Pen {
  tone(options: ToneOptions): void;
  noise(options: NoiseOptions): void;
  bell(options: BellOptions): void;
  /** A pseudo-random number in [0, 1), the same sequence for the same recipe, so a sound is recognisable. */
  random(): number;
}

export type Recipe = (pen: Pen) => void;

const BELL: readonly (readonly [number, number])[] = [
  [1, 1],
  [2.01, 0.42],
  [3.03, 0.18],
  [4.17, 0.09],
];

/** Seeded so a recipe sounds the same each time; the seed changes per play to keep a little life in it. */
function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 10_000) / 10_000;
  };
}

function makeNoise(ac: BaseAudioContext): AudioBuffer {
  const buffer = ac.createBuffer(1, ac.sampleRate * 2, ac.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** A pen drawing into `out` on `ac`, starting at `now`: the one implementation for live play and offline render. */
function makePen(ac: BaseAudioContext, out: AudioNode, now: number, noiseBuffer: AudioBuffer, seed: number): Pen {
  /** A gain node with an attack-then-exponential-decay envelope, feeding `out`. */
  const envelope = (t0: number, { dur, gain, attack = 0.005 }: Shape) => {
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t0 + Math.min(attack, dur * 0.5));
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    g.connect(out);
    return g;
  };
  const pen: Pen = {
    tone({ freq, to, type = "sine", lowpass, ...shape }) {
      const t0 = now + (shape.at ?? 0);
      const osc = ac.createOscillator();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + shape.dur);
      const g = envelope(t0, shape);
      if (lowpass) {
        const f = ac.createBiquadFilter();
        f.type = "lowpass";
        f.frequency.value = lowpass;
        osc.connect(f).connect(g);
      } else osc.connect(g);
      osc.start(t0);
      osc.stop(t0 + shape.dur + 0.05);
    },
    noise({ filter, freq, to, q = 1, ...shape }) {
      const t0 = now + (shape.at ?? 0);
      const src = ac.createBufferSource();
      src.buffer = noiseBuffer;
      const f = ac.createBiquadFilter();
      f.type = filter;
      f.frequency.setValueAtTime(freq, t0);
      if (to) f.frequency.exponentialRampToValueAtTime(to, t0 + shape.dur);
      f.Q.value = q;
      src.connect(f).connect(envelope(t0, shape));
      // Start somewhere different in the buffer each time, so repeated bursts do not sound identical.
      src.start(t0, pen.random() * 1.5, shape.dur + 0.05);
    },
    bell({ freq, partials = BELL, ...shape }) {
      for (const [ratio, weight] of partials) {
        // Higher partials die away sooner, as in a struck bell.
        pen.tone({ ...shape, freq: freq * ratio, gain: shape.gain * weight, dur: shape.dur / Math.sqrt(ratio), attack: 0.002 });
      }
    },
    random: seeded(seed),
  };
  return pen;
}

/** The same limiter live play uses, so offline renders sound like the page. */
function limiter(ac: BaseAudioContext): DynamicsCompressorNode {
  const c = ac.createDynamicsCompressor();
  c.threshold.value = -10;
  c.knee.value = 8;
  c.ratio.value = 6;
  c.attack.value = 0.003;
  c.release.value = 0.12;
  return c;
}

/** Renders a recipe offline, for checking levels or saving to a file. */
export async function renderRecipe(
  recipe: Recipe,
  { seconds = 2, sampleRate = 44_100, volume = 0.55 }: { seconds?: number; sampleRate?: number; volume?: number } = {},
): Promise<AudioBuffer> {
  const ac = new OfflineAudioContext(1, Math.ceil(seconds * sampleRate), sampleRate);
  const master = ac.createGain();
  master.gain.value = volume;
  master.connect(limiter(ac)).connect(ac.destination);
  recipe(makePen(ac, master, 0, makeNoise(ac), 1));
  return ac.startRendering();
}

/** 16-bit mono WAV bytes of a rendered buffer, cut `tail` seconds after the last audible sample. */
export function toWav(buffer: AudioBuffer, { tail = 0.05 }: { tail?: number } = {}): Uint8Array {
  const all = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < all.length; i++) if (Math.abs(all[i]!) > 0.001) last = i;
  const data = all.subarray(0, Math.min(all.length, last + Math.round(buffer.sampleRate * tail)));
  const bytes = new Uint8Array(44 + data.length * 2);
  const view = new DataView(bytes.buffer);
  const text = (at: number, s: string) => [...s].forEach((c, i) => view.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + data.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, buffer.sampleRate, true);
  view.setUint32(28, buffer.sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, data.length * 2, true);
  for (let i = 0; i < data.length; i++) view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, data[i]!)) * 0x7fff, true);
  return bytes;
}

export interface Synth {
  /** Plays a recipe now. Does nothing before the first user gesture or while muted, and then returns false. */
  play(recipe: Recipe): boolean;
  /** Call from a click or key press: browsers only start audio after a gesture. */
  unlock(): void;
  setMuted(muted: boolean): void;
  /** Overall loudness, 0..1. */
  setVolume(volume: number): void;
}

export function createSynth({ volume = 0.6 }: { volume?: number } = {}): Synth {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let noiseBuffer: AudioBuffer | null = null;
  let muted = false;
  let level = volume;
  let plays = 0;

  const audio = (): AudioContext | null => {
    if (!ctx) {
      try {
        ctx = new AudioContext();
      } catch {
        return null;
      }
      master = ctx.createGain();
      master.gain.value = level;
      // A gentle limiter: overlapping sounds stay clean instead of clipping.
      master.connect(limiter(ctx)).connect(ctx.destination);
      noiseBuffer = makeNoise(ctx);
    }
    if (ctx.state === "suspended") void ctx.resume();
    return ctx;
  };

  return {
    play(recipe) {
      if (muted || !ctx) return false;
      const ac = audio();
      if (!ac || ac.state !== "running" || !master || !noiseBuffer) return false;
      // The seed changes per play to keep a little life in repeated sounds.
      recipe(makePen(ac, master, ac.currentTime + 0.005, noiseBuffer, ++plays * 2654435761));
      return true;
    },
    unlock() {
      audio();
    },
    setMuted(value) {
      muted = value;
    },
    setVolume(value) {
      level = Math.max(0, Math.min(1, value));
      if (master) master.gain.value = level;
    },
  };
}
