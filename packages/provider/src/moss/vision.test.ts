import { describe, expect, it } from "vite-plus/test";

import { VisionSession, visionBufferedBytes, visionFrameBytes } from "./vision.ts";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
const fixture = () => {
  const text: string[] = [];
  const binary: Uint8Array[] = [];
  let ended = 0;
  let backlog = 0;
  const session = new VisionSession({
    sendText: (json) => text.push(json),
    sendBinary: (bytes) => binary.push(bytes),
    bufferedAmount: () => backlog,
    onChange: () => {},
    onEnd: () => {
      ended++;
    },
  });
  const receive = (event: object) => session.receive(JSON.stringify(event));
  const ready = (max = visionFrameBytes) => {
    session.begin();
    receive({
      type: "session.created",
      session_id: "vs-1",
      task_id: "task-1",
      model: "moss-vl-realtime-1.0",
      turn_id: 0,
      configure_timeout_s: 10,
      protocol_version: "1",
      capabilities: {},
    });
    receive({
      type: "session.configured",
      session_id: "vs-1",
      request_id: "req-1",
      max_frame_bytes: max,
      input_queue_capacity: 1,
      max_tokens_per_turn: 32,
      parked_request_timeout_s: 10,
      context_limit: 32768,
    });
    receive({ type: "session.ready", session_id: "vs-1", request_id: "req-1", turn_id: 0 });
  };
  return {
    session,
    text,
    binary,
    receive,
    ready,
    ended: () => ended,
    backlog: (value: number) => {
      backlog = value;
    },
  };
};

describe("MOSS visual realtime documented protocol", () => {
  it("configures only after creation, waits for ready, and honors the negotiated frame budget", () => {
    const f = fixture();
    f.session.begin();
    expect(f.text).toEqual([]);
    expect(f.session.frame(jpeg, 0)).toBe(false);
    f.receive({ type: "session.created" });
    expect(f.text).toEqual([JSON.stringify({ type: "session.configure", input_queue_capacity: 1, max_new_tokens: 512, include_usage: false })]);
    f.receive({ type: "session.configured", max_frame_bytes: 3 });
    expect(f.session.phase).toBe("connecting");
    f.receive({ type: "session.ready", turn_id: 0 });
    expect(f.session.maxFrameBytes).toBe(3);
    expect(f.session.frame(jpeg, 0)).toBe(false);
  });

  it("waits for frame.ready before binary and accepted before any next input", () => {
    const f = fixture();
    f.ready();
    expect(f.session.frame(jpeg, 0)).toBe(true);
    expect(f.binary).toEqual([]);
    expect(JSON.parse(f.text[1] ?? "{}")).toEqual({ type: "input.frame", seq_no: 0, timestamp: 0, mime_type: "image/jpeg" });
    f.receive({ type: "input.frame.ready", seq_no: 0 });
    expect(f.binary).toEqual([jpeg]);
    expect(f.session.frame(jpeg, 1)).toBe(false);
    f.receive({ type: "input.frame.accepted", seq_no: 0, timestamp: 0, final: false, pending_events: 1, interrupts_current_turn: false });
    expect(f.session.prompt("What is visible?")).toBe(true);
    expect(JSON.parse(f.text[2] ?? "{}")).toEqual({ type: "input.prompt", seq_no: 1, prompt: "What is visible?", final: false });
    f.receive({ type: "input.prompt.accepted", seq_no: 1, final: false, pending_events: 1, interrupts_current_turn: true });
    expect(f.session.frame(jpeg, 1)).toBe(true);
    expect(JSON.parse(f.text[3] ?? "{}").seq_no).toBe(2);
  });

  it("regression: a final visual question waits behind one frame without accepting another question", () => {
    const f = fixture();
    f.ready();
    f.session.frame(jpeg, 0);
    expect(f.session.prompt("Summarize", true)).toBe(true);
    expect(f.session.prompt("Another question")).toBe(false);
    expect(f.session.frame(jpeg, 1)).toBe(false);
    expect(f.text.map((text) => JSON.parse(text).type)).toEqual(["session.configure", "input.frame"]);
    f.receive({ type: "input.frame.ready", seq_no: 0 });
    expect(f.binary).toEqual([jpeg]);
    f.receive({ type: "input.frame.accepted", seq_no: 0 });
    expect(JSON.parse(f.text[2] ?? "{}")).toEqual({ type: "input.prompt", seq_no: 1, prompt: "Summarize", final: true });
    f.receive({ type: "input.prompt.accepted", seq_no: 1 });
    expect(f.session.frame(jpeg, 1)).toBe(false);
    expect(f.session.prompt("Another question")).toBe(false);
  });

  it.each(["stop", "disconnect"] as const)("regression: %s discards a visual question waiting for a frame", (end) => {
    const f = fixture();
    f.ready();
    f.session.frame(jpeg, 0);
    expect(f.session.prompt("Do not send after stopping")).toBe(true);
    f.session[end]();
    f.receive({ type: "input.frame.ready", seq_no: 0 });
    f.receive({ type: "input.frame.accepted", seq_no: 0 });
    f.ready();
    f.session.frame(jpeg, 0);
    f.receive({ type: "input.frame.ready", seq_no: 0 });
    f.receive({ type: "input.frame.accepted", seq_no: 0 });
    expect(f.text.map((text) => JSON.parse(text).type)).toEqual(
      end === "stop"
        ? ["session.configure", "input.frame", "session.abort", "session.configure", "input.frame"]
        : ["session.configure", "input.frame", "session.configure", "input.frame"],
    );
    expect(f.session.readyForInput).toBe(true);
  });

  it("regression: processed notifications do not prematurely release an unaccepted input", () => {
    const f = fixture();
    f.ready();
    f.session.frame(jpeg, 0);
    f.receive({ type: "input.frame.processed", seq_no: 0 });
    expect(f.session.readyForInput).toBe(false);
    f.receive({ type: "input.frame.ready", seq_no: 1 });
    expect(f.session.phase).toBe("error");
    expect(f.binary).toHaveLength(0);
  });

  it("bounds frame frequency, bytes, pending memory and upstream backlog", () => {
    const f = fixture();
    f.ready(visionFrameBytes * 2);
    expect(f.session.maxFrameBytes).toBe(visionFrameBytes);
    expect(f.session.frame(new Uint8Array(visionFrameBytes + 1), 0)).toBe(false);
    expect(f.session.frame(new Uint8Array([1, 2]), 0)).toBe(false);
    f.backlog(visionBufferedBytes + 1);
    expect(f.session.frame(jpeg, 0)).toBe(false);
    f.backlog(0);
    f.session.frame(jpeg, 0);
    f.receive({ type: "input.frame.ready", seq_no: 0 });
    f.receive({ type: "input.frame.accepted", seq_no: 0 });
    expect(f.session.frame(jpeg, 0.999)).toBe(false);
    expect(f.session.frame(jpeg, -1)).toBe(false);
    expect(f.session.frame(jpeg, Infinity)).toBe(false);
    expect(f.session.frame(jpeg, 1)).toBe(true);
    f.backlog(visionBufferedBytes + 1);
    f.receive({ type: "input.frame.ready", seq_no: 1 });
    expect(f.session.problem).toBe("backpressure");
    expect(f.binary).toHaveLength(1);
  });

  it("concatenates deltas while inputs wait and response.done does not end the session", () => {
    const f = fixture();
    f.ready();
    f.session.frame(jpeg, 0);
    f.receive({ type: "response.text.delta", response_id: "response-0", response_seq: 0, turn_id: 1, delta: "A red " });
    f.receive({ type: "response.text.delta", response_id: "response-0", response_seq: 0, turn_id: 1, delta: "car." });
    f.receive({ type: "response.done", response_id: "response-0", response_seq: 0, turn_id: 1, finish_reason: "stop", boundary: "turn" });
    expect(f.session.responses).toEqual([{ id: "response-0", sequence: 0, turn: 1, text: "A red car.", state: "done" }]);
    expect(f.session.phase).toBe("ready");
    expect(f.ended()).toBe(0);
  });

  it("regression: distinct response_seq segments are never merged even when response_id is reused", () => {
    const f = fixture();
    f.ready();
    f.receive({ type: "response.text.delta", response_id: "r", response_seq: 0, delta: "First" });
    f.receive({ type: "response.done", response_id: "r", response_seq: 0 });
    f.receive({ type: "response.text.delta", response_id: "r", response_seq: 1, delta: "Second" });
    expect(f.session.responses.map(({ text, state }) => ({ text, state }))).toEqual([
      { text: "First", state: "done" },
      { text: "Second", state: "streaming" },
    ]);
  });

  it("keeps silence normal and interrupted output explicitly partial", () => {
    const f = fixture();
    f.ready();
    f.receive({ type: "response.turn.silence", turn_id: 1, seq_no: null, timestamp: null, silence_seq: 0 });
    expect(f.session.phase).toBe("ready");
    f.receive({ type: "response.text.delta", response_id: "r", response_seq: 0, turn_id: 2, delta: "Partial" });
    f.receive({ type: "response.turn.interrupted", turn_id: 2, next_turn_id: 3, seq_no: 1 });
    expect(f.session.responses[0]?.state).toBe("interrupted");
    expect(f.session.phase).toBe("ready");
  });

  it("regression: an interruption without an active response permits the next visual answer", () => {
    const f = fixture();
    f.ready();
    f.session.frame(jpeg, 0);
    f.receive({ type: "input.frame.ready", seq_no: 0 });
    f.receive({ type: "input.frame.accepted", seq_no: 0 });
    f.session.prompt("List the colors", true);
    f.receive({ type: "input.prompt.accepted", seq_no: 1 });
    f.receive({ type: "response.turn.interrupted", turn_id: 0, next_turn_id: 1, seq_no: 1, response_id: null });
    f.receive({ type: "response.text.delta", turn_id: 1, response_id: "answer", response_seq: 0, delta: "Red, blue." });
    f.receive({ type: "response.done", turn_id: 1, response_id: "answer", response_seq: 0 });
    f.receive({ type: "session.done", reason: "completed" });
    expect(f.session.responses).toEqual([{ id: "answer", sequence: 0, turn: 1, text: "Red, blue.", state: "done" }]);
    expect(f.session.phase).toBe("ended");
    expect(f.session.problem).toBeUndefined();
  });

  it("waits for session.done, retains final usage, and forbids input after final prompt", () => {
    const f = fixture();
    f.ready();
    expect(f.session.prompt("Summarize", true)).toBe(true);
    f.receive({ type: "input.prompt.accepted", seq_no: 0 });
    expect(f.session.readyForInput).toBe(false);
    f.receive({ type: "response.done", response_id: "r", response_seq: 0, turn_id: 1 });
    expect(f.session.phase).toBe("ready");
    const usage = { vision_tokens: 10, text_input_tokens: 3, text_output_tokens: 5, text_tokens: 8, total_tokens: 18 };
    f.receive({ type: "session.done", reason: "completed", usage });
    expect(f.session.phase).toBe("ended");
    expect(f.session.usage).toEqual(usage);
    expect(f.ended()).toBe(1);
  });

  it.each(["input.frame.rejected", "error"])("terminates rejected input without retrying its potentially billable bytes: %s", (type) => {
    const f = fixture();
    f.ready();
    f.session.frame(jpeg, 0);
    f.receive({ type, seq_no: 0, code: "invalid_request", reason: "bad image", message: "private-vendor-data" });
    expect(f.session.phase).toBe("error");
    expect(f.session.problem).toBe("invalid_request");
    expect(f.session.frame(jpeg, 1)).toBe(false);
    expect(JSON.stringify(f.session.responses)).not.toContain("private-vendor-data");
  });

  it("regression: normal socket close without session.done is not successful completion", () => {
    const f = fixture();
    f.ready();
    f.receive({ type: "response.text.delta", response_id: "r", response_seq: 0, delta: "Partial" });
    f.session.disconnect();
    expect(f.session.phase).toBe("error");
    expect(f.session.responses[0]?.state).toBe("interrupted");
    expect(f.session.problem).toBe("disconnected");
  });

  it("stops once, ignores late events and never resumes a previous session", () => {
    const f = fixture();
    f.ready();
    f.session.frame(jpeg, 0);
    f.session.stop();
    f.session.stop();
    expect(f.text.filter((text) => text.includes("session.abort"))).toHaveLength(1);
    f.receive({ type: "input.frame.ready", seq_no: 0 });
    expect(f.binary).toHaveLength(0);
    f.session.begin();
    expect(f.session.phase).toBe("connecting");
    expect(f.session.responses).toEqual([]);
    f.receive({ type: "session.created" });
    expect(f.text.at(-1)).not.toContain("session_id");
  });

  it("rejects malformed messages and bounds cumulative output", () => {
    const f = fixture();
    f.ready();
    f.receive({ type: "response.text.delta", response_id: "r", response_seq: 0, delta: "x".repeat(65537) });
    expect(f.session.problem).toBe("text_limit");
    expect(f.session.responses).toHaveLength(0);
    const malformed = fixture();
    malformed.ready();
    malformed.session.receive("not JSON");
    expect(malformed.session.problem).toBe("invalid_event");
  });
});
