import { describe, expect, test } from "vite-plus/test";
import type { WorkspaceState, InboxItem, Session } from "@vibevalley/protocol";
import { tabTitle, traySummary, waitingOnOwner } from "./tray";

const call = (id: string, kind: InboxItem["kind"], tray?: string): InboxItem => ({
  id,
  kind,
  from: { kind: "session", id: "w1", name: "小吴", agent: "backend" },
  who: "小吴",
  text: "打卡写好了",
  at: 0,
  target: { kind: "session", id: "w1" },
  words: { label: "", title: "", body: "", ...(tray ? { tray } : {}) },
});

describe("the tray", () => {
  const state = (call: WorkspaceState["call"], working: number) =>
    ({
      call,
      sessions: Array.from({ length: working }, (_, i) => ({ id: `w${i}`, phase: { _tag: "working" } }) as unknown as Session),
      chat: undefined,
    }) as unknown as WorkspaceState;

  test("says whether the farm is open, what waits and what is unread", () => {
    expect(traySummary(state("idle", 0), [])).toEqual({ title: "", lines: ["还没开工"] });
    expect(traySummary(state("live", 0), [])).toEqual({ title: "", lines: ["开工了，没有在干的活"] });
    expect(traySummary(state("live", 2), [call("a", "review", "小吴 做完了，等你看"), call("b", "mention")])).toEqual({
      title: "2 · 1!",
      lines: ["2 个帮工在干活", "小吴 做完了，等你看"],
    });
  });
});

describe("what waits on the owner", () => {
  test("counts the calls at an issue or a task graph, not the mentions, which the chat counts", () => {
    const mention: InboxItem = { ...call("m", "mention"), target: { kind: "chat", channel: "c1" } };
    expect(waitingOnOwner([call("a", "review"), call("b", "ask"), mention])).toBe(2);
    expect(waitingOnOwner([])).toBe(0);
  });

  test("says it in the tab's title before the app's name", () => {
    expect(tabTitle(0, 0)).toBe("VibeValley");
    expect(tabTitle(2, 0)).toBe("(2!) VibeValley");
    expect(tabTitle(0, 5)).toBe("(5) VibeValley");
    expect(tabTitle(1, 3)).toBe("(1! · 3) VibeValley");
  });
});
