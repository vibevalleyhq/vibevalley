import { pcm16RmsLevel } from "../audio.ts";
import { appendVoiceTurn, type VoiceTurn } from "./turns.ts";

export type MossTurn = VoiceTurn<"owner" | "moss">;

/** The turns with a turn's words so far (MOSS sends them whole each time). A new turn starts a new line. */
export const heard = (turns: readonly MossTurn[], who: MossTurn["who"], key: string, text: string, done: boolean): MossTurn[] =>
  appendVoiceTurn(turns, who, key, text, done);

/** 0..100 from a frame's loudness. */
export const levelOf = pcm16RmsLevel;

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
