// A plot is a picture of where its issue stands: whatever its session's phase, the crop and the badge follow the issue's
// attention, so the farm never says what the issue page does not.

import { describe, expect, it } from "vite-plus/test";
import type { Issue, IssueAttention, Session } from "@vibevalley/protocol";
import { plotOf } from "./view.ts";
import { issueId, sessionId } from "@vibevalley/protocol/schema";

const session = (phase: Session["phase"]): Session => ({
  id: sessionId("w1"),
  name: "阿狐",
  agent: "lab",
  runtime: "pi",
  brief: "",
  hiredAt: 0,
  runs: 1,
  phase,
  issue: issueId("t1"),
});
const issue = (attention: IssueAttention, more: Partial<Issue> = {}): Issue =>
  ({
    id: "t1",
    sessions: ["w1"],
    findings: [],
    questions: [],
    status: "in_review",
    attention,
    ...more,
  }) as unknown as Issue;
const done = session({ _tag: "done" });

describe("a plot", () => {
  it("pictures its issue's attention, not its session's phase", () => {
    const cases: [IssueAttention, Partial<Issue>, string, string | undefined][] = [
      [{ state: "asking", acts: ["answer"] }, {}, "dry", "等你回答"],
      [{ state: "reviewing", lead: "complete", acts: ["complete"] }, {}, "flowering", "等你验收"],
      [{ state: "reviewing", lead: "complete", acts: ["complete"] }, { reviewedAt: 5 }, "carrot", "可收获"],
      // Reworked after a failed acceptance and handed back: it waits on the owner again, its findings are not weeds yet.
      [{ state: "reviewing", lead: "accept", acts: ["accept"] }, { findings: [{ id: "f", text: "再改", at: 1 }] }, "flowering", "等你验收"],
      // A task graph's step: it stands, but its graph is where the owner acts.
      [{ state: "reviewing", acts: [] }, {}, "flowering", undefined],
      // A conflict is not ripe, whatever the round came to.
      [{ state: "stuck", stuck: "conflict", lead: "resolve", acts: ["resolve"] }, {}, "withered", "有冲突"],
      // An answer it could not read: the round completed, the issue did not.
      [{ state: "stuck", stuck: "failed", lead: "cure", acts: ["cure"] }, { deliver: "answer" }, "withered", "有虫"],
      [{ state: "stuck", stuck: "quiet", lead: "stop", acts: ["stop"] }, {}, "dry", "没动静"],
    ];
    for (const [attention, more, crop, badge] of cases) {
      const plot = plotOf(done, issue(attention, more));
      expect({ attention, crop: plot.crop, badge: plot.badge?.text }).toEqual({
        attention,
        crop,
        badge,
      });
    }
  });

  it("stopped halfway grows where it got to, and says so", () => {
    const plot = plotOf(session({ _tag: "resting" }), issue({ state: "stuck", stuck: "interrupted", lead: "resume", acts: ["resume"] }));
    expect([plot.crop, plot.badge?.text]).toEqual(["sprout", "停在半路"]);
  });

  it("at work, fixes what a failed acceptance said", () => {
    const working = session({ _tag: "working", since: 1, doing: { action: "none", label: "" } });
    const t = issue({ state: "working", acts: ["tell"] }, { status: "in_progress", findings: [{ id: "f", text: "再改", at: 1 }] });
    expect(plotOf(working, t)).toEqual({ crop: "weeds", badge: { text: "除草中 1", tone: "bug" } });
    expect(plotOf(working, { ...t, findings: [{ id: "f", text: "再改", at: 1, resolved: true }] }).crop).toBe("sprout");
  });
});
