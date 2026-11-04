// A plot is a picture of where its issue stands: whatever its session's phase, the crop and the badge follow the issue's
// attention, so the farm never says what the issue page does not.
// Beds are here too: each project's farm lays out its own, and a saved bed never lands on one taken.

import { describe, expect, it, test } from "vite-plus/test";

import type { Issue, IssueStage, Session } from "@vibevalley/protocol";
import { issueId, sessionId } from "@vibevalley/protocol/schema";

import { emptyWorkspaceState } from "@/core/core.ts";
import { reduce } from "@/projection/reduce.ts";

import { emptyPlay, playOf, plotOf, viewOf } from "./view.ts";

const session = (phase: Session["phase"]): Session => ({
  id: sessionId("w1"),
  role: "worker",
  name: "阿狐",
  agent: "lab",
  runtime: "pi",
  brief: "",
  hiredAt: 0,
  runs: 1,
  phase,
  refining: false,
  issue: issueId("t1"),
});
const issue = (stage: IssueStage, more: Partial<Issue> = {}): Issue =>
  ({ id: "t1", sessions: ["w1"], findings: [], questions: [], status: "in_review", stage, ...more }) as unknown as Issue;
const done = session({ _tag: "done" });

describe("a plot", () => {
  it("pictures its issue's stage, not its session's phase", () => {
    const cases: [IssueStage, Partial<Issue>, string, string | undefined][] = [
      [{ state: "asking", acts: [{ act: "answer", does: "say" }] }, {}, "dry", "等你回答"],
      [{ state: "reviewing", lead: "complete", acts: [{ act: "complete", does: "say" }] }, {}, "flowering", "等你验收"],
      [{ state: "reviewing", lead: "complete", acts: [{ act: "complete", does: "say" }] }, { reviewedAt: 5 }, "carrot", "可收获"],
      // Reworked after a failed acceptance and handed back: it waits on the owner again, its findings are not weeds yet.
      [
        { state: "reviewing", lead: "complete", acts: [{ act: "complete", does: "say" }] },
        { findings: [{ id: "f", text: "再改", at: 1, resolved: false }] },
        "flowering",
        "等你验收",
      ],
      // A child issue: it stands, but its parent issue is where the owner acts.
      [{ state: "reviewing", acts: [] }, {}, "flowering", undefined],
      // A conflict is not ripe, whatever the round came to.
      [{ state: "stuck", stuck: "conflict", lead: "resolve", acts: [{ act: "resolve", does: "say" }] }, {}, "withered", "有冲突"],
      // An answer it could not read: the round completed, the issue did not.
      [{ state: "stuck", stuck: "failed", lead: "cure", acts: [{ act: "cure", does: "say" }] }, { deliver: "answer" }, "withered", "有虫"],
      [{ state: "stuck", stuck: "quiet", lead: "stop", acts: [{ act: "stop", does: "say" }] }, {}, "dry", "没动静"],
    ];
    for (const [stage, more, crop, badge] of cases) {
      const plot = plotOf(done, issue(stage, more), emptyPlay());
      expect({ stage, crop: plot.crop, badge: plot.badge?.text }).toEqual({ stage, crop, badge });
    }
  });

  it("stopped halfway grows where it got to, and says so", () => {
    const plot = plotOf(
      session({ _tag: "resting" }),
      issue({ state: "stuck", stuck: "interrupted", lead: "resume", acts: [{ act: "resume", does: "say" }] }),
      emptyPlay(),
    );
    expect([plot.crop, plot.badge?.text]).toEqual(["sprout", "停在半路"]);
  });

  it("at work, fixes what a failed acceptance said", () => {
    const working = session({ _tag: "working", since: 1, doing: { action: "none", label: "" } });
    const t = issue(
      { state: "working", acts: [{ act: "tell", does: "say" }] },
      { status: "in_progress", findings: [{ id: "f", text: "再改", at: 1, resolved: false }] },
    );
    expect(plotOf(working, t, emptyPlay())).toEqual({ crop: "weeds", badge: { text: "除草中 1", tone: "bug" } });
    expect(plotOf(working, { ...t, findings: [{ id: "f", text: "再改", at: 1, resolved: true }] }, emptyPlay()).crop).toBe("sprout");
  });

  it("is its issue's: a reopened issue's new session works the same plot", () => {
    const t = issue({ state: "working", acts: [{ act: "tell", does: "say" }] }, { status: "in_progress" });
    const first = { ...session({ _tag: "working", since: 1, doing: { action: "none", label: "" } }), hiredAt: 1 };
    const again = { ...session({ _tag: "working", since: 2, doing: { action: "none", label: "" } }), id: sessionId("w2"), hiredAt: 2 };
    const before = viewOf({ ...emptyWorkspaceState(), sessions: [first], issues: [t] }).plots;
    const after = viewOf({ ...emptyWorkspaceState(), sessions: [again], issues: [t] }).plots;
    expect([Object.keys(before), Object.keys(after)]).toEqual([["t1"], ["t1"]]);
    expect(after["t1"]).toEqual({ crop: "sprout" });
    // Both still here for a moment: the later hired is the one the plot pictures.
    expect(viewOf({ ...emptyWorkspaceState(), sessions: [again, first], issues: [t] }).plots).toEqual(after);
  });
});

describe("a bed", () => {
  const worker = (id: string, project?: string): Session => ({
    id: sessionId(id),
    role: "worker",
    name: id,
    agent: "a",
    runtime: "nobody",
    brief: "",
    ...(project !== undefined ? { project } : {}),
    hiredAt: 0,
    runs: 0,
    phase: { _tag: "working", since: 0 } as Session["phase"],
    refining: false,
  });

  const hire = (state = emptyWorkspaceState(), h: Session) => reduce(state, { type: "sessionChanged", at: 0, session: h })[0];
  const bed = (state: ReturnType<typeof emptyWorkspaceState>, id: string) => playOf(state.plays, id).station;

  test("each project's farm has its own beds: the first of each is on bed 0", () => {
    let s = hire(undefined, worker("a1", "alpha"));
    s = hire(s, worker("b1", "beta"));
    s = hire(s, worker("a2", "alpha"));
    s = hire(s, worker("x1"));
    expect([bed(s, "a1"), bed(s, "b1"), bed(s, "a2"), bed(s, "x1")]).toEqual([0, 0, 1, 0]);
  });

  test("a bed taken on another project's farm is free on this one, and taken on its own is not", () => {
    let s = hire(undefined, worker("a1", "alpha"));
    s = hire(s, worker("b1", "beta"));
    const [moved, changed] = reduce(s, { type: "progressChanged", at: 0, station: { id: sessionId("b1"), station: 3 } });
    expect(changed).toBe(true);
    // b1 holds bed 3 on beta's farm: b2 cannot take it, and stays on beta's first free bed.
    const [again, took] = reduce(hire(moved, worker("b2", "beta")), { type: "progressChanged", at: 0, station: { id: sessionId("b2"), station: 3 } });
    expect(took).toBe(false);
    expect(bed(again, "b2")).toBe(0);
  });

  test("a saved bed another session of its farm holds moves to a free one", () => {
    let s = emptyWorkspaceState();
    for (const h of [worker("a1", "alpha"), worker("a2", "alpha"), worker("b1", "beta")]) s = hire(s, h);
    s = reduce(s, { type: "progressChanged", at: 0, station: { id: sessionId("a1"), station: 3 } })[0];
    s = reduce(s, { type: "progressChanged", at: 0, station: { id: sessionId("a2"), station: 3 } })[0];
    s = reduce(s, { type: "progressChanged", at: 0, station: { id: sessionId("b1"), station: 0 } })[0];
    expect(["a1", "a2", "b1"].map((id) => bed(s, id))).toEqual([3, 1, 0]);
  });
});
