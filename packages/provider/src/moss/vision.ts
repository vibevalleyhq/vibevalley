import { Schema } from "effect";

import { jsonText } from "../json.ts";

export const visionFrameBytes = 256 * 1024;
export const visionFrameIntervalMs = 1000;
export const visionBufferedBytes = 512 * 1024;

const Usage = Schema.Struct({
  vision_tokens: Schema.Finite,
  text_input_tokens: Schema.Finite,
  text_output_tokens: Schema.Finite,
  text_tokens: Schema.Finite,
  total_tokens: Schema.Finite,
});
const Event = Schema.fromJsonString(
  Schema.Struct({
    type: Schema.String,
    seq_no: Schema.optionalKey(Schema.NullOr(Schema.Int)),
    max_frame_bytes: Schema.optionalKey(Schema.Int),
    turn_id: Schema.optionalKey(Schema.Int),
    response_id: Schema.optionalKey(Schema.NullOr(Schema.String)),
    response_seq: Schema.optionalKey(Schema.Int),
    delta: Schema.optionalKey(Schema.String),
    reason: Schema.optionalKey(Schema.String),
    code: Schema.optionalKey(Schema.String),
    usage: Schema.optionalKey(Usage),
  }),
);
const decode = Schema.decodeUnknownOption(Event);

export interface VisionResponse {
  readonly id: string;
  readonly sequence: number;
  readonly turn: number;
  readonly text: string;
  readonly state: "streaming" | "done" | "interrupted";
}
export interface VisionCallbacks {
  readonly sendText: (json: string) => void;
  readonly sendBinary: (bytes: Uint8Array) => void;
  readonly bufferedAmount: () => number;
  readonly onChange: () => void;
  readonly onEnd: () => void;
}

type Pending = { readonly kind: "frame"; readonly bytes: Uint8Array; readonly timestamp: number; sent: boolean } | { readonly kind: "prompt" };

export class VisionSession {
  phase: "idle" | "connecting" | "ready" | "ended" | "error" = "idle";
  problem: string | undefined = undefined;
  responses: readonly VisionResponse[] = [];
  maxFrameBytes = visionFrameBytes;
  usage: typeof Usage.Type | undefined = undefined;
  lastEvent = "";
  private seq = 0;
  private created = false;
  private configured = false;
  private final = false;
  private timestamp = -Infinity;
  private pending: Pending | undefined = undefined;
  private queuedPrompt: { readonly text: string; readonly final: boolean } | undefined = undefined;
  private textBytes = 0;
  private readonly callbacks: VisionCallbacks;

  constructor(callbacks: VisionCallbacks) {
    this.callbacks = callbacks;
  }

  get readyForInput(): boolean {
    return !this.pending && this.readyForPrompt;
  }

  get readyForPrompt(): boolean {
    return (
      this.phase === "ready" && this.pending?.kind !== "prompt" && !this.queuedPrompt && !this.final && this.callbacks.bufferedAmount() <= visionBufferedBytes
    );
  }

  begin(): void {
    if (this.phase === "connecting" || this.phase === "ready") return;
    this.phase = "connecting";
    this.problem = undefined;
    this.responses = [];
    this.usage = undefined;
    this.lastEvent = "";
    this.maxFrameBytes = visionFrameBytes;
    this.seq = 0;
    this.created = false;
    this.configured = false;
    this.final = false;
    this.timestamp = -Infinity;
    this.pending = undefined;
    this.queuedPrompt = undefined;
    this.textBytes = 0;
    this.callbacks.onChange();
  }

  frame(bytes: Uint8Array, timestamp: number): boolean {
    if (
      !this.readyForInput ||
      bytes.byteLength === 0 ||
      bytes.byteLength > this.maxFrameBytes ||
      !Number.isFinite(timestamp) ||
      timestamp < 0 ||
      timestamp - this.timestamp < visionFrameIntervalMs / 1000
    )
      return false;
    // The capture source supplies JPEG; accepting arbitrary binary here would mislabel the wire format.
    if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) return false;
    this.pending = { kind: "frame", bytes, timestamp, sent: false };
    this.send({ type: "input.frame", seq_no: this.seq, timestamp, mime_type: "image/jpeg" });
    return true;
  }

  prompt(text: string, final = false): boolean {
    const prompt = text.trim();
    if (!this.readyForPrompt || !prompt || prompt.length > 8000) return false;
    if (this.pending) this.queuedPrompt = { text: prompt, final };
    else this.sendPrompt(prompt, final);
    return true;
  }

  receive(json: string): void {
    if (this.phase !== "connecting" && this.phase !== "ready") return;
    if (json.length > 256 * 1024) return this.fail("message_limit");
    const result = decode(json);
    if (result._tag === "None") return this.fail("invalid_event");
    const event = result.value;
    this.lastEvent = event.type;
    switch (event.type) {
      case "session.created":
        if (this.created) return this.fail("invalid_sequence");
        this.created = true;
        this.send({ type: "session.configure", input_queue_capacity: 1, max_new_tokens: 512, include_usage: false });
        break;
      case "session.configured":
        if (!this.created || this.configured || event.max_frame_bytes === undefined || event.max_frame_bytes < 1) return this.fail("invalid_sequence");
        this.configured = true;
        this.maxFrameBytes = Math.min(visionFrameBytes, event.max_frame_bytes);
        break;
      case "session.ready":
        if (!this.configured) return this.fail("invalid_sequence");
        this.phase = "ready";
        break;
      case "input.frame.ready":
        if (event.seq_no !== this.seq || this.pending?.kind !== "frame" || this.pending.sent) return this.fail("invalid_sequence");
        if (this.callbacks.bufferedAmount() > visionBufferedBytes) return this.fail("backpressure");
        this.pending.sent = true;
        this.callbacks.sendBinary(this.pending.bytes);
        break;
      case "input.frame.accepted":
      case "input.prompt.accepted":
        if (
          event.seq_no !== this.seq ||
          !this.pending ||
          event.type !== `input.${this.pending.kind}.accepted` ||
          (this.pending.kind === "frame" && !this.pending.sent)
        )
          return this.fail("invalid_sequence");
        if (this.pending.kind === "frame") this.timestamp = this.pending.timestamp;
        this.pending = undefined;
        this.seq++;
        if (this.queuedPrompt) {
          const prompt = this.queuedPrompt;
          this.queuedPrompt = undefined;
          this.sendPrompt(prompt.text, prompt.final);
        }
        break;
      case "input.frame.rejected":
        return this.fail("invalid_request");
      case "response.text.delta": {
        if (!event.response_id || event.response_seq === undefined || event.response_seq < 0 || event.delta === undefined) return this.fail("invalid_event");
        this.textBytes += event.delta.length;
        if (this.textBytes > 65536) return this.fail("text_limit");
        const index = this.responses.findIndex((response) => response.id === event.response_id && response.sequence === event.response_seq);
        if (index < 0) {
          if (this.responses.length >= 64) return this.fail("response_limit");
          this.responses = [
            ...this.responses,
            { id: event.response_id, sequence: event.response_seq, turn: event.turn_id ?? -1, text: event.delta, state: "streaming" },
          ];
        } else this.responses = this.responses.map((response, i) => (i === index ? { ...response, text: response.text + event.delta } : response));
        break;
      }
      case "response.done":
        if (!event.response_id || event.response_seq === undefined || event.response_seq < 0) return this.fail("invalid_event");
        this.responses = this.responses.map((response) =>
          response.id === event.response_id && response.sequence === event.response_seq ? { ...response, state: "done" } : response,
        );
        break;
      case "response.turn.interrupted":
        this.responses = this.responses.map((response) =>
          response.state === "streaming" && (response.turn === event.turn_id || response.turn === -1) ? { ...response, state: "interrupted" } : response,
        );
        break;
      case "session.done":
        this.usage = event.usage;
        if (event.reason !== "completed" && event.reason !== "aborted") return this.fail("session_failed");
        this.finish();
        return;
      case "error":
        return this.fail(
          ["invalid_request", "context_exhausted", "session_timeout", "response_failed", "session_capacity_exceeded"].includes(event.code ?? "")
            ? (event.code ?? "session_failed")
            : "session_failed",
        );
      default:
        // Processed/usage/silence events do not release the transport's awaiting-acceptance slot.
        break;
    }
    this.callbacks.onChange();
  }

  stop(): void {
    if (this.phase !== "ready" && this.phase !== "connecting") return;
    if (this.created) this.send({ type: "session.abort" });
    this.finish();
  }

  disconnect(): void {
    if (this.phase === "ready" || this.phase === "connecting") this.fail("disconnected");
  }

  private sendPrompt(prompt: string, final: boolean): void {
    this.pending = { kind: "prompt" };
    this.final = final;
    this.send({ type: "input.prompt", seq_no: this.seq, prompt, final });
  }

  private send(event: object): void {
    this.callbacks.sendText(jsonText(event));
  }

  private fail(problem: string): void {
    this.problem = problem;
    this.finish("error");
  }

  private finish(phase: "ended" | "error" = "ended"): void {
    this.phase = phase;
    this.pending = undefined;
    this.queuedPrompt = undefined;
    this.responses = this.responses.map((response) => (response.state === "streaming" ? { ...response, state: "interrupted" } : response));
    this.callbacks.onChange();
    this.callbacks.onEnd();
  }
}
