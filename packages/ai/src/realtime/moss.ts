import { decodeMossFrame, mossOutRate, mossTaggedFrameBytes, packTaggedAudio, unpackPcm16 } from "@vibevalley/provider/moss";

import { jsonText } from "../base/json.ts";
import { heard, levelOf, type MossEvent, type MossPhase, type MossQos, type MossSetup, type MossTurn, noQos, noisyMossActions } from "./moss-session.ts";
import { type Piece, Playback, type PlaybackAction, type Queued } from "./playback.ts";

export type MossOutboundAction =
  | PlaybackAction
  | { readonly action: "attach_session"; readonly memory_scope: "session" }
  | { readonly action: "session.update"; readonly session: { readonly persona?: { readonly prompt: string }; readonly instructions: string } }
  | { readonly action: "media.mode"; readonly binary_protocol: "tagged-v1" }
  | { readonly action: "mic_state"; readonly enabled: boolean }
  | { readonly action: "video.state"; readonly source: "camera" | "screen"; readonly enabled: boolean }
  | { readonly action: "video.stream_focus"; readonly source: "camera" | "screen" | "auto" };

export interface MossEngineCallbacks {
  readonly sendText: (json: string) => void;
  readonly sendBinary: (bytes: ArrayBuffer | Uint8Array) => void;
  readonly bufferedAmount: () => number;
  readonly nowSeconds: () => number;
  readonly nowMs: () => number;
  readonly onReadyForMedia: () => void;
  readonly onEnqueueAudio: (piece: Piece, pcm: ArrayBuffer, queued: Queued) => void;
  readonly onCutAudio: (run: string, turn: string, stop: readonly Queued[]) => void;
  readonly onEnd: () => void;
  readonly onChange: () => void;
}

interface Response {
  readonly turn: string;
  readonly chunks: Set<string>;
  audioDone: boolean;
  ended: boolean;
  /** Whether its audio was cut: cutting until the page says where playback stopped, then cut. */
  stop: "none" | "cutting" | "cut";
}

// Local safety budgets, not vendor-advertised protocol limits.
const maxJsonChars = 64 * 1024;
const maxPcmBytes = mossOutRate * 2 * 5;
const maxQueuedMs = 30_000;
const maxResponses = 2048;
const maxChunks = 8192;
const maxTextChars = 16_000;
const scopedErrors: Readonly<Record<string, true>> = {
  unknown_call_id: true,
  invalid_content: true,
  content_too_long: true,
  invalid_delegation_id: true,
  unknown_delegation_id: true,
  invalid_status: true,
  instructions_full: true,
  invalid_event_id: true,
  event_id_conflict: true,
  delegation_terminal: true,
  delegation_cancel_failed: true,
  presentation_capacity: true,
};

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
  private handshake: "idle" | "opening" | "attaching" | "configuring" | "ready" = "idle";
  private window = { up: 0, down: 0, frames: 0 };
  private heardAt: number | undefined = undefined;
  private replyTotal = 0;
  private piece: Piece | undefined = undefined;
  private workletAheadMs: number | undefined = undefined;
  private chunkCount = 0;
  private readonly responses = new Map<string, Response>();
  private readonly video = new Set<"camera" | "screen">();
  private readonly videoAt = new Map<"camera" | "screen", number>();
  private readonly callbacks: MossEngineCallbacks;

  constructor(callbacks: MossEngineCallbacks) {
    this.callbacks = callbacks;
  }

  begin(setup: MossSetup): void {
    if (this.phase !== "idle") return;
    this.setup = setup;
    this.phase = "connecting";
    this.handshake = "opening";
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
    this.responses.clear();
    this.chunkCount = 0;
    this.video.clear();
    this.videoAt.clear();
    this.playback.clear();
    this.callbacks.onChange();
  }

  socketOpened(): void {
    if (this.handshake !== "opening" || this.phase !== "connecting") return;
    this.handshake = "attaching";
    this.send({ action: "attach_session", memory_scope: "session" });
  }

  mediaOpened(): void {
    if (this.handshake !== "ready" || this.phase !== "connecting") return;
    this.send({ action: "mic_state", enabled: true });
    this.phase = "live";
    this.callbacks.onChange();
  }

  micFrameTagged(frame: ArrayBuffer, level: number): void {
    if (this.phase !== "live" || frame.byteLength !== mossTaggedFrameBytes || this.callbacks.bufferedAmount() + mossTaggedFrameBytes > 64 * 1024) return;
    const bytes = new Uint8Array(frame);
    if (bytes[0] !== 0) return;
    if (this.muted) bytes.fill(0, 1);
    this.micLevel = this.muted ? 0 : level;
    this.callbacks.sendBinary(frame);
    this.window.up += frame.byteLength;
    this.window.frames++;
    this.callbacks.onChange();
  }

  micFramePcm(pcmBuffer: ArrayBuffer): void {
    if (this.phase !== "live" || pcmBuffer.byteLength !== mossTaggedFrameBytes - 1 || this.callbacks.bufferedAmount() + mossTaggedFrameBytes > 64 * 1024)
      return;
    const pcm = unpackPcm16(pcmBuffer);
    this.micLevel = this.muted ? 0 : levelOf(pcm);
    const bytes = packTaggedAudio(pcm, this.muted);
    this.callbacks.sendBinary(bytes);
    this.window.up += bytes.byteLength;
    this.window.frames++;
    this.callbacks.onChange();
  }

  micSentFromWorker(byteLength: number, level: number): void {
    if (this.phase !== "live" || byteLength !== mossTaggedFrameBytes) return;
    this.micLevel = this.muted ? 0 : level;
    this.window.up += byteLength;
    this.window.frames++;
    this.callbacks.onChange();
  }

  videoState(source: "camera" | "screen", enabled: boolean): void {
    if (this.phase !== "live" || this.video.has(source) === enabled) return;
    if (enabled) this.video.add(source);
    else this.video.delete(source);
    this.send({ action: "video.state", source, enabled });
  }

  videoFocus(source: "camera" | "screen" | "auto"): void {
    if (this.phase === "live") this.send({ action: "video.stream_focus", source });
  }

  videoFrame(bytes: Uint8Array, source: "camera" | "screen"): boolean {
    const now = this.callbacks.nowMs();
    if (
      this.phase !== "live" ||
      !this.video.has(source) ||
      bytes.length < 4 ||
      bytes.length > 256 * 1024 ||
      bytes[0] !== 0xff ||
      bytes[1] !== 0xd8 ||
      bytes.at(-2) !== 0xff ||
      bytes.at(-1) !== 0xd9 ||
      now - (this.videoAt.get(source) ?? -Infinity) < 1000 ||
      this.callbacks.bufferedAmount() + bytes.length + 1 > 512 * 1024
    )
      return false;
    const tagged = new Uint8Array(bytes.length + 1);
    tagged[0] = source === "camera" ? 1 : 2;
    tagged.set(bytes, 1);
    this.callbacks.sendBinary(tagged);
    this.videoAt.set(source, now);
    this.window.up += tagged.length;
    return true;
  }

  socketText(data: string): void {
    if (this.phase === "idle" || this.phase === "ending") return;
    if (data.length > maxJsonChars) return this.end("live_event_limit");
    this.window.down += data.length;
    const m = decodeMossFrame(data);
    if (m === undefined) return;
    const action = m.action ?? "";
    const d = m.data ?? {};
    const text = d.text ?? "";
    if (text.length > maxTextChars) return this.end("live_text_limit");
    if (!noisyMossActions.has(action)) this.log(false, action);
    if (action === "session.closing") return this.end();
    if (action === "error") {
      this.problem = "live_request_rejected";
      const error = d.error;
      const scoped = typeof error !== "string" && error !== undefined && (Boolean(error.client_event_id) || scopedErrors[error.code ?? ""] === true);
      if (this.phase === "connecting" || !scoped) return this.end(this.problem);
      this.callbacks.onChange();
      return;
    }
    if (action === "session_attached") {
      if (this.handshake !== "attaching") return;
      if (!d.session_id || d.memory_scope !== "session" || d.delegation !== "none") return this.end("live_session_options");
      this.handshake = "configuring";
      const persona = this.setup.persona.trim();
      this.send({
        action: "session.update",
        session: {
          ...(persona ? { persona: { prompt: persona } } : {}),
          instructions: this.setup.instructions.trim(),
        },
      });
      return;
    }
    if (action === "session.updated") {
      if (this.handshake !== "configuring") return;
      if (d.error !== "") return this.end("live_configuration_rejected");
      this.handshake = "ready";
      this.send({ action: "media.mode", binary_protocol: "tagged-v1" });
      this.callbacks.onReadyForMedia();
      return;
    }
    if (this.phase !== "live") return;
    let run = d.run_id ?? "";
    let turn = d.turn_id ?? "";
    if (action === "response.interrupted" && !run && !turn) {
      for (const [id, response] of this.responses) {
        if (response.ended) continue;
        if (run) {
          run = "";
          turn = "";
          break;
        }
        run = id;
        turn = response.turn;
      }
    }
    switch (action) {
      case "input.transcript.updated":
      case "input.transcript.done":
        this.turns = heard(this.turns, "user", d.turn ?? "", text, action.endsWith("done")).slice(-200);
        break;
      case "input.transcript.revised":
        if (d.turn) this.turns = this.turns.map((entry) => (entry.who === "user" && entry.key === d.turn ? { ...entry, text } : entry));
        break;
      case "output.transcript.updated":
      case "output.transcript.done": {
        const response = run || turn ? this.response(run, turn) : undefined;
        if ((run || turn) && (!response || response.ended || response.stop !== "none")) break;
        this.turns = heard(this.turns, "moss", turn, text, action.endsWith("done")).slice(-200);
        break;
      }
      case "response.audio.started":
        this.response(run, turn);
        break;
      case "response.audio.context": {
        this.piece = undefined;
        const response = this.response(run, turn);
        if (
          !response ||
          response.audioDone ||
          response.ended ||
          response.stop !== "none" ||
          !d.chunk_id ||
          d.chunk_id.length > 256 ||
          response.chunks.has(d.chunk_id)
        )
          break;
        if (this.chunkCount >= maxChunks) return this.end("live_chunk_limit");
        response.chunks.add(d.chunk_id);
        this.chunkCount++;
        this.piece = { chunk: d.chunk_id, run, turn };
        break;
      }
      case "response.audio.done": {
        const response = this.responses.get(run);
        if (!response || response.turn !== turn || response.audioDone || response.stop !== "none") break;
        response.audioDone = true;
        this.tell(this.playback.sent(run, turn));
        break;
      }
      case "input.speech.stopped":
        this.heardAt = this.callbacks.nowMs();
        break;
      case "response.audio.stop":
      case "response.interrupted": {
        const response = this.responses.get(run);
        if (!response || response.turn !== turn) break;
        if (response.stop === "none") {
          const reason = action === "response.audio.stop" ? "stopped" : "interrupted";
          this.qos = { ...this.qos, stops: { ...this.qos.stops, [reason]: (this.qos.stops[reason] ?? 0) + 1 } };
        }
        if (action === "response.interrupted") {
          response.ended = true;
          this.turns = heard(this.turns, "moss", turn, text, true).slice(-200);
        }
        this.cut(run, turn);
        break;
      }
      case "response.ended": {
        const response = this.response(run, turn);
        if (!response || response.ended) break;
        response.ended = true;
        this.turns = this.turns.map((entry) => (entry.who === "moss" && entry.key === turn ? { ...entry, done: true } : entry));
        if (d.status === "failed" || d.status === "aborted") this.cut(run, turn);
        break;
      }
      default:
        break;
    }
    this.callbacks.onChange();
  }

  socketBinary(data: ArrayBuffer): void {
    const piece = this.piece;
    this.piece = undefined;
    if (this.phase !== "live" || !piece || (this.responses.get(piece.run)?.stop ?? "none") !== "none") return;
    if (data.byteLength === 0 || data.byteLength % 2 !== 0 || data.byteLength > maxPcmBytes) return this.end("live_pcm_invalid");
    const durationMs = (data.byteLength / (mossOutRate * 2)) * 1000;
    if (this.playback.playing.length >= 512 || this.playback.playing.reduce((sum, q) => sum + q.ms, 0) + durationMs > maxQueuedMs)
      return this.end("live_playback_limit");
    this.window.down += data.byteLength;
    const pcm = unpackPcm16(data);
    this.mossLevel = levelOf(pcm);
    if (this.heardAt !== undefined) {
      const ms = Math.max(0, this.callbacks.nowMs() - this.heardAt);
      this.heardAt = undefined;
      this.replyTotal += ms;
      const replies = this.qos.replies + 1;
      this.qos = { ...this.qos, replies, replyMs: Math.round(ms), replyMeanMs: Math.round(this.replyTotal / replies) };
    }
    const queued = this.playback.queue(piece, durationMs / 1000, this.callbacks.nowSeconds());
    this.qos = { ...this.qos, gaps: this.playback.gaps };
    this.callbacks.onEnqueueAudio(piece, data, queued);
    this.callbacks.onChange();
  }

  chunkEnded(queued: Queued): void {
    if (this.phase !== "live") return;
    this.tell(this.playback.ended(queued));
    if (this.playback.playing.length === 0) this.mossLevel = 0;
    this.callbacks.onChange();
  }

  chunkEndedById(chunk: string, run: string, aheadMs?: number): void {
    if (this.phase !== "live") return;
    if (aheadMs !== undefined) this.workletAheadMs = aheadMs;
    this.tell(this.playback.endedById(chunk, run));
    if (this.playback.playing.length === 0) {
      this.mossLevel = 0;
      this.workletAheadMs = 0;
    }
    this.callbacks.onChange();
  }

  audioStopped(run: string, turn: string, partialPlayedMs: number): void {
    const response = this.responses.get(run);
    if (this.phase !== "live" || response?.stop !== "cutting" || response.turn !== turn) return;
    response.stop = "cut";
    const { actions } = this.playback.cutSampleAccurate(run, turn, partialPlayedMs);
    this.tell(actions.length > 0 ? actions : [{ action: "playback.stopped", run_id: run, turn_id: turn, played_audio_ms: 0 }]);
    this.mossLevel = 0;
    this.workletAheadMs = undefined;
    this.callbacks.onChange();
  }

  outLevelChanged(level: number, aheadMs: number): void {
    if (this.phase !== "live") return;
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
    this.handshake = "idle";
    this.setup = { persona: "", instructions: "" };
    this.heardAt = undefined;
    this.piece = undefined;
    this.workletAheadMs = undefined;
    this.playback.clear();
    this.responses.clear();
    this.video.clear();
    this.videoAt.clear();
    this.micLevel = 0;
    this.mossLevel = 0;
    this.muted = false;
    if (problem) this.problem = problem;
    this.phase = "idle";
    this.callbacks.onChange();
  }

  private response(run: string, turn: string): Response | undefined {
    if (!run || !turn || run.length > 256 || turn.length > 256) return undefined;
    const existing = this.responses.get(run);
    if (existing) return existing.turn === turn ? existing : undefined;
    if (this.responses.size >= maxResponses) {
      this.end("live_response_limit");
      return undefined;
    }
    const response: Response = { turn, chunks: new Set(), audioDone: false, ended: false, stop: "none" };
    this.responses.set(run, response);
    return response;
  }

  private cut(run: string, turn: string): void {
    const response = this.responses.get(run);
    if (!response || response.stop !== "none") return;
    response.stop = "cutting";
    if (this.piece?.run === run) this.piece = undefined;
    this.callbacks.onCutAudio(
      run,
      turn,
      this.playback.playing.filter((q) => q.run === run),
    );
  }

  private end(problem?: string): void {
    if (this.phase === "idle" || this.phase === "ending") return;
    this.phase = "ending";
    this.handshake = "idle";
    this.piece = undefined;
    this.video.clear();
    if (problem) this.problem = problem;
    this.callbacks.onChange();
    this.callbacks.onEnd();
  }

  private tell(actions: readonly PlaybackAction[]): void {
    for (const action of actions) {
      if (action.action === "playback.completed" && (this.responses.get(action.run_id)?.stop ?? "none") !== "none") continue;
      this.send(action);
    }
  }

  private send(action: MossOutboundAction): void {
    const text = jsonText(action);
    this.callbacks.sendText(text);
    this.window.up += text.length;
    if (!noisyMossActions.has(action.action)) this.log(true, action.action);
    this.callbacks.onChange();
  }

  private log(up: boolean, action: string): void {
    if (!/^[a-z][a-z_.]{0,63}$/u.test(action)) return;
    this.events = [...this.events.slice(-199), { up, text: jsonText({ action }) }];
  }
}
