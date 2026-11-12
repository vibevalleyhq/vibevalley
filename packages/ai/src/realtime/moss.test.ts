import { describe, expect, it } from "vite-plus/test";

import { mossAudioTag, mossFrameSamples, mossTaggedFrameBytes, packTaggedAudio, unpackPcm16 } from "@vibevalley/provider/moss";

import { jsonText, parsedJson } from "../base/json.ts";
import { heard, levelOf, type MossTurn } from "./moss-session.ts";
import { MossEngine } from "./moss.ts";
import { Playback } from "./playback.ts";

const parsed = (text: string) => parsedJson(text);

describe("heard", () => {
  it("revises a turn's words in place and starts a line for the next turn", () => {
    let turns: MossTurn[] = [];
    turns = heard(turns, "moss", "t1", "Hel", false);
    turns = heard(turns, "moss", "t1", "Hello", true);
    turns = heard(turns, "moss", "t2", "Again", false);
    expect(turns).toEqual([
      { who: "moss", key: "t1", text: "Hello", done: true },
      { who: "moss", key: "t2", text: "Again", done: false },
    ]);
  });

  it("names the user's line when MOSS names its turn, and keeps the sides apart", () => {
    let turns: MossTurn[] = [];
    turns = heard(turns, "user", "", "hi", false);
    turns = heard(turns, "moss", "m1", "yes", false);
    turns = heard(turns, "user", "o1", "hi there", true);
    expect(turns).toEqual([
      { who: "user", key: "o1", text: "hi there", done: true },
      { who: "moss", key: "m1", text: "yes", done: false },
    ]);
  });

  it("ignores empty words", () => {
    expect(heard([], "user", "o1", "", false)).toEqual([]);
  });
});

describe("levelOf and tagged-v1 framing", () => {
  it("is 0 for silence and nothing, and tops out at 100", () => {
    expect(levelOf(new Int16Array(320))).toBe(0);
    expect(levelOf(new Int16Array(0))).toBe(0);
    expect(levelOf(new Int16Array(320).fill(0x7fff))).toBe(100);
  });

  it("packs 320 PCM samples into a 641-byte tagged-v1 frame and zeroes payload when muted", () => {
    const pcm = new Int16Array(mossFrameSamples).fill(1024);
    const live = packTaggedAudio(pcm, false);
    expect(live.byteLength).toBe(mossTaggedFrameBytes);
    expect(live[0]).toBe(mossAudioTag);
    const unpacked = unpackPcm16(live.slice(1).buffer);
    expect(unpacked[0]).toBe(1024);

    const muted = packTaggedAudio(pcm, true);
    expect(muted.byteLength).toBe(mossTaggedFrameBytes);
    expect(muted.every((b) => b === 0)).toBe(true);
  });
});

const piece = (chunk: string, run = "r1", turn = "t1") => ({ chunk, run, turn });

describe("Playback", () => {
  it("queues pieces back to back, and says a run is complete once it is both sent and played", () => {
    const p = new Playback();
    const a = p.queue(piece("c1"), 0.2, 1);
    const b = p.queue(piece("c2"), 0.2, 1.05);
    expect([a.at, b.at]).toEqual([1, 1.2]);
    expect(p.aheadMs(1.1)).toBe(300);
    expect(p.ended(a)).toEqual([{ action: "playback.chunk.completed", chunk_id: "c1", run_id: "r1", turn_id: "t1" }]);
    expect(p.sent("r1", "t1")).toEqual([]);
    expect(p.endedById("c2", "r1")).toEqual([
      { action: "playback.chunk.completed", chunk_id: "c2", run_id: "r1", turn_id: "t1" },
      { action: "playback.completed", run_id: "r1", turn_id: "t1" },
    ]);
    expect(p.gaps).toBe(0);
  });

  it("completes a run sent after its last piece played", () => {
    const p = new Playback();
    p.ended(p.queue(piece("c1"), 0.2, 0));
    expect(p.sent("r1", "t1")).toEqual([{ action: "playback.completed", run_id: "r1", turn_id: "t1" }]);
  });

  it("counts a gap when a run's next piece comes after the one before has finished", () => {
    const p = new Playback();
    p.queue(piece("c1"), 0.2, 0);
    p.queue(piece("c2"), 0.2, 0.5);
    p.queue(piece("c3", "r2"), 0.2, 2);
    expect(p.gaps).toBe(1);
  });

  it("cuts a run with how far it got, and supports sample-accurate worklet cuts", () => {
    const p = new Playback();
    const a = p.queue(piece("c1"), 0.2, 0);
    const b = p.queue(piece("c2"), 0.2, 0);
    p.ended(a);
    const { stop, actions } = p.cut("r1", "t1", 0.25);
    expect(stop).toEqual([b]);
    expect(actions).toEqual([{ action: "playback.stopped", run_id: "r1", turn_id: "t1", played_audio_ms: 50 }]);
    expect(p.ended(b)).toEqual([]);
    expect(p.aheadMs(0.25)).toBe(0);

    const p2 = new Playback();
    p2.ended(p2.queue(piece("c1"), 0.2, 0));
    p2.queue(piece("c2"), 0.2, 0.2);
    expect(p2.cutSampleAccurate("r1", "t1", 75).actions).toEqual([{ action: "playback.stopped", run_id: "r1", turn_id: "t1", played_audio_ms: 75 }]);
  });

  it("says nothing when cutting a run it never heard of", () => {
    expect(new Playback().cut("r9", "t9", 1)).toEqual({ stop: [], actions: [] });
  });
});

describe("MossEngine end-to-end session state machine", () => {
  it("drives handshake, tagged-v1 media mode, audio playback, and interruption cuts", () => {
    const sentText: string[] = [];
    const sentBinary: number[] = [];
    const cutRuns: string[] = [];
    let nowSec = 0;
    let nowMs = 1000;
    let readyCount = 0;

    const engine = new MossEngine({
      sendText: (json) => sentText.push(json),
      sendBinary: (bytes) => sentBinary.push(bytes.byteLength),
      bufferedAmount: () => 0,
      nowSeconds: () => nowSec,
      nowMs: () => nowMs,
      onReadyForMedia: () => {
        readyCount++;
        engine.mediaOpened();
      },
      onEnqueueAudio: () => {},
      onCutAudio: (run) => cutRuns.push(run),
      onEnd: () => {},
      onChange: () => {},
    });

    engine.begin({ persona: "calm", instructions: "speak concisely" });
    expect(engine.phase).toBe("connecting");

    engine.socketOpened();
    expect(parsed(sentText.at(-1) ?? "{}")).toEqual({ action: "attach_session", memory_scope: "session" });

    engine.socketText(jsonText({ action: "session_attached", data: { session_id: "s1", memory_scope: "session", delegation: "none" } }));
    expect(parsed(sentText.at(-1) ?? "{}")).toEqual({
      action: "session.update",
      session: { persona: { prompt: "calm" }, instructions: "speak concisely" },
    });

    engine.socketText(jsonText({ action: "session.updated", data: { error: "", tools: [] } }));
    expect(readyCount).toBe(1);
    expect(engine.phase).toBe("live");
    expect(sentText.slice(-2).map(parsed)).toEqual([
      { action: "media.mode", binary_protocol: "tagged-v1" },
      { action: "mic_state", enabled: true },
    ]);

    engine.micFrameTagged(new ArrayBuffer(mossTaggedFrameBytes), 42);
    expect(engine.micLevel).toBe(42);
    expect(sentBinary).toEqual([mossTaggedFrameBytes]);

    engine.socketText(jsonText({ action: "input.speech.stopped" }));
    nowMs = 1320;
    engine.socketText(jsonText({ action: "response.audio.context", data: { chunk_id: "c1", run_id: "r1", turn_id: "t1" } }));
    const pcm48k = new Int16Array(4800).fill(0x4000);
    engine.socketBinary(pcm48k.buffer);
    expect(engine.qos.replyMs).toBe(320);
    expect(engine.mossLevel).toBeGreaterThan(0);

    nowSec = 0.05;
    engine.socketText(jsonText({ action: "response.interrupted", data: { run_id: "r1", turn_id: "t1", text: "Hold on" } }));
    expect(cutRuns).toEqual(["r1"]);
    expect(engine.turns).toEqual([{ who: "moss", key: "t1", text: "Hold on", done: true }]);
    expect(sentText.some((text) => text.includes("playback.stopped"))).toBe(false);
    engine.audioStopped("r1", "t1", 50);
    expect(parsed(sentText.at(-1) ?? "{}")).toEqual({
      action: "playback.stopped",
      run_id: "r1",
      turn_id: "t1",
      played_audio_ms: 50,
    });
  });
});
