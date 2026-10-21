import { describe, expect, test } from "vite-plus/test";
import type { CoreState, InboxItem, Session } from "@vibevalley/protocol";
import { CallBell, noticeFor, traySummary } from "./notice";

const call = (id: string, kind: InboxItem["kind"], text = "打卡写好了"): InboxItem => ({
  id,
  kind,
  from: { kind: "session", id: "w1", name: "小吴", agent: "backend" },
  text,
  at: 0,
  target: { kind: "session", id: "w1" },
});

describe("the inbox bell", () => {
  test("rings only on calls that came after the page opened, each once", () => {
    const bell = new CallBell();
    expect(bell.ring([call("a", "merge")])).toEqual([]);
    expect(bell.ring([call("a", "merge"), call("b", "fix")]).map((c) => c.id)).toEqual(["b"]);
    expect(bell.ring([call("a", "merge"), call("b", "fix")])).toEqual([]);
  });

  test("says who and what, in one line", () => {
    expect(noticeFor(call("a", "merge", "打卡\n  写好了"))).toEqual({ title: "小吴 做完了", body: "打卡 写好了" });
    expect(noticeFor({ ...call("s", "schedule-ask", "每天看测试"), from: { kind: "manager" } })).toEqual({
      title: "管家想定一个定时",
      body: "「每天看测试」：同意了才开始",
    });
  });
});

describe("the tray", () => {
  const state = (call: CoreState["call"], working: number) =>
    ({
      call,
      sessions: Array.from({ length: working }, (_, i) => ({ id: `w${i}`, phase: { _tag: "working" } }) as unknown as Session),
      chat: undefined,
    }) as unknown as CoreState;

  test("says whether the farm is open, what waits and what is unread", () => {
    expect(traySummary(state("idle", 0), [])).toEqual({ title: "", lines: ["还没开工"] });
    expect(traySummary(state("live", 0), [])).toEqual({ title: "", lines: ["开工了，没有在干的活"] });
    expect(traySummary(state("live", 2), [call("a", "merge"), call("b", "mention")])).toEqual({
      title: "2 · 1!",
      lines: ["2 个帮工在干活", "小吴 做完了，可以收"],
    });
  });
});
