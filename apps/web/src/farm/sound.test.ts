import { describe, expect, test } from "vite-plus/test";
import type { Session } from "@vibevalley/protocol";
import { farmCues, isMuted, playSound, SOUND_GROUPS, SOUND_LABEL, SOUNDS, type FarmSoundInput } from "./sound";

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
      { kind: "reward", sessionId: "a", coins: 3, streak: 1 },
      { kind: "penalty", sessionId: "b" },
      { kind: "levelUp", level: 2 },
    ] as const;
    expect(farmCues(base, { ...base, effects: [...effects] })).toEqual([
      { name: "coin", hold: 300 },
      { name: "levelUp", hold: 700 },
    ]);
    const same = [...effects];
    expect(farmCues({ ...base, effects: same }, { ...base, effects: same })).toEqual([]);
  });

  test("sessions arrive, ripen and fail, but not in the first state", () => {
    const next = [session("a", "working"), session("b", "ripe"), session("c", "failed")];
    expect(farmCues(base, { ...base, sessions: next })).toEqual([]);
    const prev = [session("b", "working"), session("c", "working")];
    expect(farmCues({ ...base, sessions: prev }, { ...base, sessions: next })).toEqual([{ name: "arrive" }, { name: "ripe", hold: 220 }, { name: "bug" }]);
  });

  test("the call", () => {
    const at = (phase: "idle" | "connecting" | "live" | "ending", problem?: string) => ({ ...base, call: { phase, problem } });
    expect(farmCues(at("connecting"), at("live"))).toEqual([{ name: "voiceOn" }]);
    expect(farmCues(at("ending"), at("idle"))).toEqual([{ name: "voiceOff" }]);
    expect(farmCues(at("connecting"), at("idle"))).toEqual([]);
    expect(farmCues(at("connecting"), at("idle", "声网：1"))).toEqual([{ name: "nope" }]);
  });
});

test("every sound has a label and a group", () => {
  const names = Object.keys(SOUNDS).sort();
  expect(Object.keys(SOUND_LABEL).sort()).toEqual(names);
  expect(SOUND_GROUPS.flatMap((g) => g.names).sort()).toEqual(names as (typeof SOUND_GROUPS)[number]["names"][number][]);
});

test("without audio or storage it stays quiet", () => {
  expect(isMuted()).toBe(false);
  expect(() => playSound("coin")).not.toThrow();
});
