import { describe, expect, test } from "vite-plus/test";
import type { WorkspaceState, InboxItem, Session } from "@vibevalley/protocol";
import { traySummary } from "./tray";

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
