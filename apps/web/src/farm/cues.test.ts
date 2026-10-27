import { describe, expect, test } from "vite-plus/test";
import type { IssueAttention, Session, IssueAct, IssueAction } from "@vibevalley/protocol";
import { issueId, sessionId } from "@vibevalley/protocol/schema";
import { farmCues, type FarmSoundInput } from "./cues";

/** The issue's buttons by name, as the server sends them. */
const buttons = (...names: IssueAct[]): IssueAction[] =>
  names.map((act): IssueAction => {
    switch (act) {
      case "tell":
      case "answer":
        return { act, does: "say" };
      case "stop":
        return { act, does: "stop" };
      case "complete":
      case "acknowledge":
        return { act, does: "move", status: "done", words: "none" };
      case "close":
        return { act, does: "move", status: "canceled", words: "none" };
      case "reject":
      case "reopen":
        return { act, does: "move", status: "todo", words: "required" };
      case "start":
      case "cure":
      case "resolve":
      case "resume":
        return { act, does: "move", status: "todo", words: "none" };
    }
  });

const base: FarmSoundInput = { tool: "hand", bedFx: [], open: {} };

const session = (id: string, tag: Session["phase"]["_tag"]) => ({ id, phase: { _tag: tag } }) as Session;

describe("farmCues", () => {
  test("nothing changed, nothing plays", () => {
    expect(farmCues(base, { ...base, open: {} })).toEqual([]);
  });

  test("a new tool, new bed effects and flipped panels", () => {
    const prev = { ...base, bedFx: [{ id: 1, kind: "water" as const }], open: { chat: true } };
    const next = {
      tool: "can",
      bedFx: [
        { id: 1, kind: "water" as const },
        { id: 2, kind: "note" as const },
      ],
      open: { chat: false, friends: true, panel: false },
    };
    expect(farmCues(prev, next).map((c) => c.name)).toEqual(["pick", "nope", "close", "open"]);
  });

  test("a new effects array plays each good effect in turn", () => {
    const effects = [
      { kind: "reward", sessionId: sessionId("a"), coins: 3, streak: 1 },
      { kind: "penalty", sessionId: sessionId("b") },
      { kind: "levelUp", level: 2 },
    ] as const;
    expect(farmCues(base, { ...base, effects: [...effects] })).toEqual([
      { name: "coin", hold: 300 },
      { name: "levelUp", hold: 700 },
    ]);
    const same = [...effects];
    expect(farmCues({ ...base, effects: same }, { ...base, effects: same })).toEqual([]);
  });

  test("sessions arrive and issues ripen or fail, but not in the first state", () => {
    const next = [session("a", "working"), session("b", "done"), session("c", "failed")];
    expect(farmCues(base, { ...base, sessions: next })).toEqual([]);
    const prev = [session("b", "working"), session("c", "working")];
    expect(farmCues({ ...base, sessions: prev }, { ...base, sessions: next })).toEqual([{ name: "arrive" }]);
    const issue = (id: string, attention: IssueAttention) => ({ id: issueId(id), attention });
    const working: IssueAttention = { state: "working", acts: [] };
    const before = [issue("b", working), issue("c", working), issue("d", working)];
    const after = [
      issue("b", { state: "reviewing", acts: buttons("complete") }),
      issue("c", { state: "stuck", stuck: "failed", acts: buttons("cure") }),
      // Handed back with a question: where it stands is asking, and its plot is neither ripe nor buggy.
      issue("d", { state: "asking", acts: buttons("answer") }),
    ];
    expect(farmCues({ ...base, issues: before }, { ...base, issues: after })).toEqual([{ name: "ripe", hold: 220 }, { name: "bug" }]);
  });

  test("the call", () => {
    const at = (phase: "idle" | "connecting" | "live" | "ending", problem?: string) => ({ ...base, call: { phase, problem } });
    expect(farmCues(at("connecting"), at("live"))).toEqual([{ name: "voiceOn" }]);
    expect(farmCues(at("ending"), at("idle"))).toEqual([{ name: "voiceOff" }]);
    expect(farmCues(at("connecting"), at("idle"))).toEqual([]);
    expect(farmCues(at("connecting"), at("idle", "声网：1"))).toEqual([{ name: "nope" }]);
  });
});
