import { decodeMossFrame, mossOutRate, packTaggedAudio, unpackPcm16 } from "@vibevalley/provider/moss";

import { heard, levelOf, type MossEvent, type MossPhase, type MossQos, type MossSetup, type MossTurn, noQos, noisyMossActions } from "./moss-session.ts";
import { type Piece, Playback, type PlaybackAction, type Queued } from "./playback.ts";

export type MossOutboundAction =
  | PlaybackAction
  | { readonly action: "attach_session" }
  | { readonly action: "session.update"; readonly session: { readonly persona?: { readonly prompt: string }; readonly instructions: string } }
  | { readonly action: "media.mode"; readonly binary_protocol: "tagged-v1" }
  | { readonly action: "mic_state"; readonly enabled: boolean };

export interface MossEngineCallbacks {
  readonly sendText: (json: string) => void;
  readonly sendBinary: (bytes: ArrayBuffer | Uint8Array) => void;
  readonly bufferedAmount: () => number;
  readonly nowSeconds: () => number;
  readonly nowMs: () => number;
  readonly onReadyForMedia: () => void;
  readonly onEnqueueAudio: (piece: Piece, pcm: ArrayBuffer, queued: Queued) => void;
  readonly onCutAudio: (run: string, turn: string, stop: readonly Queued[]) => void;
  readonly onChange: () => void;
}

/**
 * Pure protocol & session state machine for a MOSS Live call.
 * Runs identically inside a dedicated Web Worker or on the main thread (and in unit tests without DOM globals).
 */
export class MossEngine {
  phase: MossPhase = "idle";
  problem: string | undefined = undefined;
  muted = false;
  micLevel = 0;
  mossLevel = 0;
  turns: MossTurn[] = [];
  events: MossEvent[] = [];
  qos: MossQos = noQos();
  readonly playback = new Playback();

  private setup: MossSetup = { persona: "", instructions: "" };
  private window = { up: 0, down: 0, frames: 0 };
  private heardAt: number | undefined = undefined;
  private replyTotal = 0;
  private piece: Piece | undefined = undefined;
  private workletAheadMs: number | undefined = undefined;
  private readonly callbacks: MossEngineCallbacks;

  constructor(callbacks: MossEngineCallbacks) {
    this.callbacks = callbacks;
  }

  begin(setup: MossSetup): void {
    this.setup = setup;
    this.phase = "connecting";
    this.problem = undefined;
    this.muted = false;
    this.micLevel = 0;
    this.mossLevel = 0;
    this.turns = [];
    this.events = [];
    this.qos = noQos();
    this.replyTotal = 0;
    this.heardAt = undefined;
    this.piece = undefined;
    this.workletAheadMs = undefined;
    this.window = { up: 0, down: 0, frames: 0 };
    this.playback.clear();
    this.callbacks.onChange();
  }

  socketOpened(): void {
    this.send({ action: "attach_session" });
  }

  mediaOpened(): void {
    this.send({ action: "media.mode", binary_protocol: "tagged-v1" });
    this.send({ action: "mic_state", enabled: true });
    this.phase = "live";
    this.callbacks.onChange();
  }

  /** Receives a pre-packed 641-byte tagged-v1 frame and RMS level from the CaptureWorklet. */
  micFrameTagged(frame: ArrayBuffer, level: number): void {
    this.micLevel = this.muted ? 0 : level;
    this.callbacks.sendBinary(frame);
    this.window.up += frame.byteLength;
    this.window.frames++;
    this.callbacks.onChange();
  }

  /** Receives raw 16-bit PCM from a legacy capture worklet, computes RMS level, and packs tagged-v1. */
  micFramePcm(pcmBuffer: ArrayBuffer): void {
    const pcm = unpackPcm16(pcmBuffer);
    this.micLevel = this.muted ? 0 : levelOf(pcm);
    const bytes = packTaggedAudio(pcm, this.muted);
    this.callbacks.sendBinary(bytes);
    this.window.up += bytes.byteLength;
    this.window.frames++;
    this.callbacks.onChange();
  }

  /** Updates the uplink accounting when the transport Web Worker sends a mic frame directly to the WebSocket. */
  micSentFromWorker(byteLength: number, level: number): void {
    this.micLevel = this.muted ? 0 : level;
    this.window.up += byteLength;
    this.window.frames++;
    this.callbacks.onChange();
  }

  socketText(data: string): void {
    this.window.down += data.length;
    const decoded = decodeMossFrame(data);
    if (decoded._tag === "None") return;
    const m = decoded.value;
    const action = m.action ?? "";
    if (!noisyMossActions.has(action)) this.log(false, data);
    const d = m.data ?? {};
    const text = d.text ?? "";
    switch (action) {
      case "session_attached": {
        const persona = this.setup.persona.trim();
        this.send({
          action: "session.update",
          session: {
            ...(persona ? { persona: { prompt: persona } } : {}),
            instructions: this.setup.instructions.trim(),
          },
        });
        break;
      }
      case "session.updated":
        if (typeof d.error === "string" && d.error !== "") this.problem = d.error;
        if (this.phase === "connecting") this.callbacks.onReadyForMedia();
        break;
      case "input.transcript.updated":
      case "input.transcript.done":
        this.turns = heard(this.turns, "owner", d.turn ?? "", text, action.endsWith("done"));
        break;
      case "output.transcript.updated":
      case "output.transcript.done":
        this.turns = heard(this.turns, "moss", d.turn_id ?? "", text, action.endsWith("done"));
        break;
      case "response.audio.context":
        this.piece = { chunk: d.chunk_id ?? "", run: d.run_id ?? "", turn: d.turn_id ?? "" };
        break;
      case "response.audio.done":
        this.tell(this.playback.sent(d.run_id ?? "", d.turn_id ?? ""));
        break;
      case "input.speech.stopped":
        this.heardAt = this.callbacks.nowMs();
        break;
      case "response.audio.stop": {
        const reason = d.reason || "?";
        this.qos = {
          ...this.qos,
          stops: { ...this.qos.stops, [reason]: (this.qos.stops[reason] ?? 0) + 1 },
        };
        this.cut(d.run_id ?? "", d.turn_id ?? "");
        break;
      }
      case "response.interrupted":
        this.turns = heard(this.turns, "moss", d.turn_id ?? "", text, true);
        this.cut(d.run_id ?? "", d.turn_id ?? "");
        break;
      case "error": {
        const e = d.error;
        this.problem = typeof e === "string" ? e : (e?.message ?? data);
        break;
      }
      default:
        break;
    }
    this.callbacks.onChange();
  }

  socketBinary(data: ArrayBuffer): void {
    this.window.down += data.byteLength;
    const piece = this.piece;
    this.piece = undefined;
    if (!piece) return;
    const pcm = unpackPcm16(data);
    this.mossLevel = levelOf(pcm);
    if (this.heardAt !== undefined) {
      const ms = Math.max(0, this.callbacks.nowMs() - this.heardAt);
      this.heardAt = undefined;
      this.replyTotal += ms;
      const replies = this.qos.replies + 1;
      this.qos = {
        ...this.qos,
        replies,
        replyMs: Math.round(ms),
        replyMeanMs: Math.round(this.replyTotal / replies),
      };
    }
    const durationSeconds = pcm.length / mossOutRate;
    const queued = this.playback.queue(piece, durationSeconds, this.callbacks.nowSeconds());
    this.qos = { ...this.qos, gaps: this.playback.gaps };
    this.callbacks.onEnqueueAudio(piece, data, queued);
    this.callbacks.onChange();
  }

  chunkEnded(queued: Queued): void {
    this.tell(this.playback.ended(queued));
    if (this.playback.playing.length === 0) this.mossLevel = 0;
    this.callbacks.onChange();
  }

  chunkEndedById(chunk: string, run: string, aheadMs?: number): void {
    if (aheadMs !== undefined) this.workletAheadMs = aheadMs;
    this.tell(this.playback.endedById(chunk, run));
    if (this.playback.playing.length === 0) {
      this.mossLevel = 0;
      this.workletAheadMs = 0;
    }
    this.callbacks.onChange();
  }

  outLevelChanged(level: number, aheadMs: number): void {
    this.mossLevel = level;
    this.workletAheadMs = aheadMs;
    this.callbacks.onChange();
  }

  mute(on: boolean): void {
    if (this.phase !== "live" || this.muted === on) return;
    this.muted = on;
    if (on) this.micLevel = 0;
    this.send({ action: "mic_state", enabled: !on });
  }

  measure(aheadMsOverride?: number): void {
    this.qos = {
      ...this.qos,
      upKbps: Math.round((this.window.up * 8) / 1000),
      downKbps: Math.round((this.window.down * 8) / 1000),
      framesPerSecond: this.window.frames,
      backlog: this.callbacks.bufferedAmount(),
      aheadMs: aheadMsOverride ?? this.workletAheadMs ?? this.playback.aheadMs(this.callbacks.nowSeconds()),
      gaps: this.playback.gaps,
    };
    this.window = { up: 0, down: 0, frames: 0 };
    this.callbacks.onChange();
  }

  reset(problem?: string): void {
    this.heardAt = undefined;
    this.piece = undefined;
    this.workletAheadMs = undefined;
    this.playback.clear();
    this.micLevel = 0;
    this.mossLevel = 0;
    this.muted = false;
    if (problem) this.problem = problem;
    this.phase = "idle";
    this.callbacks.onChange();
  }

  private cut(run: string, turn: string): void {
    const { stop, actions } = this.playback.cut(run, turn, this.callbacks.nowSeconds());
    this.callbacks.onCutAudio(run, turn, stop);
    if (actions.length > 0) {
      this.mossLevel = 0;
      this.workletAheadMs = 0;
    }
    this.tell(actions);
  }

  private tell(actions: readonly PlaybackAction[]): void {
    for (const a of actions) this.send(a);
  }

  private send(action: MossOutboundAction): void {
    const text = JSON.stringify(action);
    this.callbacks.sendText(text);
    this.window.up += text.length;
    if (!noisyMossActions.has(action.action)) this.log(true, text);
    this.callbacks.onChange();
  }

  private log(up: boolean, text: string): void {
    this.events = [...this.events.slice(-199), { up, text }];
  }
}
