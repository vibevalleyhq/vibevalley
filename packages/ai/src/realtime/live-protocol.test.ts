import { describe, expect, it } from "vite-plus/test";

import { mossTaggedFrameBytes } from "@vibevalley/provider/moss";

import { MossEngine } from "./moss.ts";
import { Playback } from "./playback.ts";

const attached = { action: "session_attached", data: { session_id: "live-session-1", memory_scope: "session", delegation: "none" } };
const updated = { action: "session.updated", data: { error: "", tools: ["ask_orchestrator"] } };
const context = (chunk = "c1", run = "r1", turn = "t1") => ({ action: "response.audio.context", data: { run_id: run, turn_id: turn, chunk_id: chunk } });

function fixture() {
  const sent: string[] = [];
  const binary: Uint8Array[] = [];
  const queued: string[] = [];
  const cut: string[] = [];
  let ready = 0;
  let ended = 0;
  let now = 0;
  let buffered = 0;
  const engine = new MossEngine({
    sendText: (json) => sent.push(json),
    sendBinary: (bytes) => binary.push(new Uint8Array(bytes instanceof ArrayBuffer ? bytes : bytes.slice().buffer)),
    bufferedAmount: () => buffered,
    nowMs: () => now,
    nowSeconds: () => now / 1000,
    onReadyForMedia: () => {
      ready++;
      engine.mediaOpened();
    },
    onEnqueueAudio: (piece) => queued.push(piece.chunk),
    onCutAudio: (run) => cut.push(run),
    onEnd: () => {
      ended++;
    },
    onChange: () => {},
  });
  const receive = (event: unknown) => engine.socketText(JSON.stringify(event));
  const begin = () => {
    engine.begin({ persona: "private persona", instructions: "private instructions" });
    engine.socketOpened();
  };
  const live = () => {
    begin();
    receive(attached);
    receive(updated);
  };
  return {
    engine,
    sent,
    binary,
    queued,
    cut,
    receive,
    begin,
    live,
    ready: () => ready,
    ended: () => ended,
    clock: (value: number) => {
      now = value;
    },
    backlog: (value: number) => {
      buffered = value;
    },
  };
}

describe("official Live lifecycle fixtures", () => {
  it("regression: configuration errors never open media or retain vendor payloads in diagnostics", () => {
    const f = fixture();
    f.begin();
    f.receive(attached);
    f.receive({ action: "session.updated", data: { error: "secret credential/private instructions" } });
    f.engine.mediaOpened();
    f.engine.micFrameTagged(new ArrayBuffer(mossTaggedFrameBytes), 10);
    expect(f.ready()).toBe(0);
    expect(f.ended()).toBe(1);
    expect(f.binary).toEqual([]);
    expect(f.engine.phase).toBe("ending");
    expect(JSON.stringify(f.engine.events)).not.toMatch(/secret|private/u);
    expect(f.engine.problem).toBe("live_configuration_rejected");
  });

  it("regression: unsolicited acknowledgements and duplicate handshakes cannot start capture", () => {
    const f = fixture();
    f.begin();
    f.receive(updated);
    expect(f.ready()).toBe(0);
    f.receive(attached);
    f.receive(attached);
    f.receive(updated);
    f.receive(updated);
    expect(f.ready()).toBe(1);
    expect(f.sent.filter((json) => json.includes("session.update"))).toHaveLength(1);
    expect(f.sent.slice(-2).map((json) => JSON.parse(json).action)).toEqual(["media.mode", "mic_state"]);
  });

  it("regression: closing never resumes a session or account, even when vendor permits reconnect", () => {
    const f = fixture();
    f.live();
    f.receive({ action: "session.closing", data: { code: "rotation", reason: "private reason", reconnect: true } });
    const count = f.sent.length;
    f.engine.socketOpened();
    f.receive(updated);
    f.receive(context());
    f.engine.socketBinary(new ArrayBuffer(960));
    expect(f.sent).toHaveLength(count);
    expect(f.queued).toEqual([]);
    expect(f.ended()).toBe(1);
    f.engine.reset();
    f.begin();
    expect(JSON.parse(f.sent.at(-1) ?? "{}")).toEqual({ action: "attach_session", memory_scope: "session" });
    expect(f.engine.turns).toEqual([]);
    expect(f.engine.events.some((event) => /live-session-1|private/u.test(event.text))).toBe(false);
  });

  it("regression: unexpected user memory or delegation cannot silently change privacy scope", () => {
    for (const data of [
      { session_id: "s", memory_scope: "user", delegation: "none" },
      { session_id: "s", memory_scope: "session", delegation: "client" },
    ]) {
      const f = fixture();
      f.begin();
      f.receive({ action: "session_attached", data });
      expect(f.ended()).toBe(1);
      expect(f.ready()).toBe(0);
    }
  });

  it("regression: accepts a PCM frame only once with its context and rejects stale stopped audio", () => {
    const f = fixture();
    f.live();
    f.engine.socketBinary(new ArrayBuffer(960));
    f.receive(context());
    f.engine.socketBinary(new ArrayBuffer(960));
    f.receive(context());
    f.engine.socketBinary(new ArrayBuffer(960));
    f.receive(context("c2", "r1", "wrong-turn"));
    f.engine.socketBinary(new ArrayBuffer(960));
    expect(f.queued).toEqual(["c1"]);
    f.receive({ action: "response.audio.stop", data: { run_id: "r1", turn_id: "t1", reason: "new_reason" } });
    expect(f.cut).toEqual(["r1"]);
    expect(f.sent.some((event) => event.includes("playback.stopped"))).toBe(false);
    f.engine.audioStopped("r1", "t1", 5);
    expect(JSON.parse(f.sent.at(-1) ?? "{}")).toEqual({ action: "playback.stopped", run_id: "r1", turn_id: "t1", played_audio_ms: 5 });
    f.receive(context("c3"));
    f.engine.socketBinary(new ArrayBuffer(960));
    f.receive({ action: "response.audio.done", data: { run_id: "r1", turn_id: "t1" } });
    expect(f.queued).toEqual(["c1"]);
    expect(f.sent.some((event) => event.includes('"action":"playback.completed"'))).toBe(false);
  });

  it("regression: bounds PCM shape, queue bytes, and oversized text before allocation", () => {
    for (const bytes of [1, 0, 480_002]) {
      const f = fixture();
      f.live();
      f.receive(context());
      f.engine.socketBinary(new ArrayBuffer(bytes));
      expect(f.ended()).toBe(1);
      expect(f.queued).toEqual([]);
    }
    const f = fixture();
    f.live();
    for (let i = 0; i < 7; i++) {
      f.receive(context(`c${i}`));
      f.engine.socketBinary(new ArrayBuffer(480_000));
    }
    expect(f.queued).toHaveLength(6);
    expect(f.engine.problem).toBe("live_playback_limit");
    const large = fixture();
    large.live();
    large.engine.socketText(" ".repeat(65_537));
    expect(large.engine.problem).toBe("live_event_limit");
  });

  it("regression: finished response does not end the call and transcript revisions replace history", () => {
    const f = fixture();
    f.live();
    f.receive({ action: "input.transcript.done", data: { turn: "owner-1", text: "old" } });
    f.receive({ action: "input.transcript.revised", data: { turn: "owner-1", previous: "old", text: "corrected" } });
    f.receive({ action: "output.transcript.done", data: { run_id: "r1", turn_id: "t1", text: "answer" } });
    f.receive({ action: "response.ended", data: { run_id: "r1", turn_id: "t1", status: "completed" } });
    f.receive({ action: "output.transcript.updated", data: { run_id: "r1", turn_id: "t1", text: "stale" } });
    f.receive(context("late"));
    f.engine.socketBinary(new ArrayBuffer(960));
    expect(f.engine.phase).toBe("live");
    expect(f.engine.turns.map((turn) => turn.text)).toEqual(["corrected", "answer"]);
    expect(f.queued).toEqual([]);
  });

  it("regression: tagged media never leaks muted PCM and limits JPEG frames without queuing", () => {
    const f = fixture();
    const jpeg = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
    expect(f.engine.videoFrame(jpeg, "camera")).toBe(false);
    f.live();
    f.engine.videoState("camera", true);
    expect(f.engine.videoFrame(jpeg, "camera")).toBe(true);
    expect([...(f.binary[0] ?? [])]).toEqual([1, ...jpeg]);
    expect(f.engine.videoFrame(jpeg, "camera")).toBe(false);
    f.clock(1000);
    f.backlog(512 * 1024);
    expect(f.engine.videoFrame(jpeg, "camera")).toBe(false);
    f.backlog(0);
    f.engine.mute(true);
    const mic = new Uint8Array(mossTaggedFrameBytes).fill(123);
    mic[0] = 0;
    f.engine.micFrameTagged(mic.buffer, 90);
    expect(f.binary.at(-1)?.every((byte) => byte === 0)).toBe(true);
    f.engine.videoState("camera", false);
    expect(f.engine.videoFrame(jpeg, "camera")).toBe(false);
  });

  it("regression: playback receipts exclude acknowledged chunks and duplicate terminal notifications", () => {
    const p = new Playback();
    const first = p.queue({ run: "r1", turn: "t1", chunk: "c1" }, 0.2, 0);
    p.queue({ run: "r1", turn: "t1", chunk: "c2" }, 0.2, 0);
    p.ended(first);
    expect(p.cutSampleAccurate("r1", "t1", 75).actions[0]).toEqual({ action: "playback.stopped", run_id: "r1", turn_id: "t1", played_audio_ms: 75 });
    expect(p.sent("r1", "t1")).toEqual([]);
    const q = new Playback();
    q.ended(q.queue({ run: "r1", turn: "t1", chunk: "c1" }, 0.2, 0));
    expect(q.sent("r1", "t1")).toHaveLength(1);
    expect(q.sent("r1", "t1")).toEqual([]);
  });
});

it("regression: scoped tool errors preserve audio but unscoped session errors release the call", () => {
  const f = fixture();
  f.live();
  f.receive({ action: "error", data: { type: "error", error: { code: "unknown_call_id", message: "private tool result" } } });
  expect(f.engine.phase).toBe("live");
  expect(f.ended()).toBe(0);
  f.receive({ action: "error", data: { type: "error", error: { code: "invalid_public_request", message: "private media payload" } } });
  expect(f.engine.phase).toBe("ending");
  expect(f.ended()).toBe(1);
  expect(JSON.stringify(f.engine.events)).not.toContain("private");
});

it("regression: interrupted events without IDs affect only an unambiguous active response", () => {
  const f = fixture();
  f.live();
  f.receive(context());
  f.engine.socketBinary(new ArrayBuffer(960));
  f.receive({ action: "response.interrupted", data: { text: "interrupted answer", reason: "playback failure" } });
  expect(f.cut).toEqual(["r1"]);
  expect(f.engine.turns).toEqual([{ who: "moss", key: "t1", text: "interrupted answer", done: true }]);
  expect(f.engine.phase).toBe("live");
});
