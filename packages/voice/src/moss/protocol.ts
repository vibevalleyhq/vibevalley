import { Schema } from "effect";

export const mossRealtimeUrl = "wss://api.mosi.cn/v1/realtime?model=moss-live-1.0";

export const mossInRate = 16000;
export const mossOutRate = 48000;
export const mossFrameSamples = 320;
export const mossFrameBytes = mossFrameSamples * 2;
export const mossTaggedFrameBytes = 1 + mossFrameBytes;
export const mossAudioTag = 0x00;

export const MossErrorObjectSchema = Schema.Struct({
  message: Schema.optionalKey(Schema.String),
});

export const MossEventPayloadSchema = Schema.Struct({
  text: Schema.optionalKey(Schema.String),
  turn: Schema.optionalKey(Schema.String),
  turn_id: Schema.optionalKey(Schema.String),
  chunk_id: Schema.optionalKey(Schema.String),
  run_id: Schema.optionalKey(Schema.String),
  reason: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Union([Schema.String, MossErrorObjectSchema])),
});

export const MossFrameSchema = Schema.fromJsonString(
  Schema.Struct({
    action: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(MossErrorObjectSchema),
    data: Schema.optionalKey(MossEventPayloadSchema),
  }),
);

export const decodeMossFrame = Schema.decodeUnknownOption(MossFrameSchema);

/** The message of a refusal's JSON body ({ error: { message } }), or the body itself, cut short. */
export const mossErrorMessage = (body: string): string => {
  const decoded = decodeMossFrame(body);
  const msg = decoded._tag === "Some" ? decoded.value.error?.message : undefined;
  return msg ? msg : body.slice(0, 200);
};

/** One side's words in a turn; done once MOSS has settled them. */
export interface MossTurn {
  readonly who: "owner" | "moss";
  readonly key: string;
  readonly text: string;
  readonly done: boolean;
}

/** The turns with a turn's words so far (MOSS sends them whole each time). A new turn starts a new line. */
export function heard(turns: readonly MossTurn[], who: MossTurn["who"], key: string, text: string, done: boolean): MossTurn[] {
  if (text === "") return [...turns];
  let last: MossTurn | undefined;
  for (const x of turns) if (x.who === who && !x.done && (x.key === "" || key === "" || x.key === key)) last = x;
  if (!last) return [...turns, { who, key, text, done }];
  return turns.map((x) => (x === last ? { ...x, key: key || x.key, text, done } : x));
}

/** 0..100 from a frame's loudness. */
export function levelOf(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sum = 0;
  for (const s of pcm) sum += (s / 0x8000) ** 2;
  return Math.min(100, Math.round(Math.sqrt(sum / pcm.length) * 300));
}

/** Packs 16-bit PCM samples into MOSS Live's tagged-v1 binary frame (leading 0x00 tag byte + PCM payload, or silence when muted). */
export function packTaggedAudio(pcm: Int16Array, muted = false): Uint8Array {
  const bytes = new Uint8Array(1 + pcm.byteLength);
  bytes[0] = mossAudioTag;
  if (!muted) bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), 1);
  return bytes;
}

/** Views an incoming binary audio buffer as 16-bit PCM samples. */
export function unpackPcm16(data: ArrayBuffer): Int16Array {
  return new Int16Array(data, 0, Math.floor(data.byteLength / 2));
}

export type MossPhase = "idle" | "connecting" | "live" | "ending";

/** An action sent or an event received, as JSON; the noisy ones (words as they grow, audio announcements) are left out. */
export interface MossEvent {
  readonly up: boolean;
  readonly text: string;
}

/** How the line is doing, worked out once a second from what passed on it. */
export interface MossQos {
  /** kbit/s over the last second, both ways, audio and JSON together. */
  upKbps: number;
  downKbps: number;
  /** Microphone frames sent in the last second: 50 when capture and the socket keep up. */
  framesPerSecond: number;
  /** Bytes the socket holds that have not gone out yet: grows when the way up is too slow. */
  backlog: number;
  /** The answer's audio already here and not yet played, ms. */
  aheadMs: number;
  /** Times the answer ran dry: a piece came after the one before had finished playing, in the same answer. */
  gaps: number;
  /** From the end of the owner's words (input.speech.stopped) to MOSS's first sound arriving, ms: the last and the mean. */
  replyMs?: number;
  replyMeanMs?: number;
  replies: number;
  /** Answers MOSS stopped itself, by the reason it gave (response.audio.stop). */
  stops: Record<string, number>;
}

export const noQos = (): MossQos => ({
  upKbps: 0,
  downKbps: 0,
  framesPerSecond: 0,
  backlog: 0,
  aheadMs: 0,
  gaps: 0,
  replies: 0,
  stops: {},
});

export interface MossSetup {
  readonly persona: string;
  readonly instructions: string;
}

export interface MossMessages {
  readonly closed: () => string;
  readonly noMic: () => string;
  readonly formatError: (e: unknown) => string;
}

export const noisyMossActions: ReadonlySet<string> = new Set([
  "input.transcript.updated",
  "output.transcript.updated",
  "response.audio.context",
  "playback.chunk.completed",
]);
