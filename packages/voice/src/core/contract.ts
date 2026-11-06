export type VoicePhase = "idle" | "connecting" | "live" | "ending";

export type VoiceSpeaker = "owner" | "moss" | "orchestrator";

/** One side's words in a voice turn; `done` once the provider has settled them. */
export interface VoiceTurn<Who extends string = VoiceSpeaker> {
  readonly who: Who;
  readonly key: string;
  readonly text: string;
  readonly done: boolean;
}

/** Provider-agnostic reactive contract for a live two-way voice session (implemented by MOSS Live and Agora). */
export interface VoiceDriver<Setup = void, Who extends string = VoiceSpeaker> {
  readonly phase: VoicePhase;
  readonly muted: boolean;
  /** 0..100 microphone loudness level. */
  readonly inputLevel: number;
  /** 0..100 remote / assistant loudness level. */
  readonly outputLevel: number;
  readonly turns: readonly VoiceTurn<Who>[];
  readonly problem: string | undefined;
  readonly version: number;
  readonly subscribe: (listener: () => void) => () => void;
  start(setup: Setup): Promise<void>;
  mute(on: boolean): void | Promise<void>;
  end(): void | Promise<void>;
}

/** Pure reducer updating or appending a speaker's turn in place; an empty text is ignored and a settled turn starts a new line next time. */
export function appendVoiceTurn<Who extends string>(
  turns: readonly VoiceTurn<Who>[],
  who: Who,
  key: string,
  text: string,
  done: boolean,
): VoiceTurn<Who>[] {
  if (text === "") return [...turns];
  let last: VoiceTurn<Who> | undefined;
  for (const x of turns) if (x.who === who && !x.done && (x.key === "" || key === "" || x.key === key)) last = x;
  if (!last) return [...turns, { who, key, text, done }];
  return turns.map((x) => (x === last ? { ...x, key: key || x.key, text, done } : x));
}

/** 0..100 RMS loudness level from 16-bit PCM samples. */
export function pcm16RmsLevel(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (const s of pcm) sum += (s / 0x8000) ** 2;
  return Math.min(100, Math.round(Math.sqrt(sum / pcm.length) * 300));
}

/** 0..1 RMS loudness level from normalized Float32 audio samples. */
export function float32RmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const s of samples) sum += s * s;
  return Math.min(1, Math.sqrt(sum / samples.length) * 4);
}
