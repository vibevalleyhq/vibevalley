import { describe, expect, it } from "vite-plus/test";

import { Hub } from "@vibevalley/async";
import type * as T from "@vibevalley/protocol";
import { issueId, sessionId } from "@vibevalley/protocol/schema";

import { makeCore } from "#/core/core.ts";
import { makeFrameOf } from "#/gateway/projection/frame.ts";
import { reduce } from "#/gateway/projection/reduce.ts";
import { keptLog } from "#/infra/log.ts";
import { wallTime } from "#/infra/time.ts";
import { effectsOf } from "#/modules/game/view.ts";

import { watchIssue } from "./watch.ts";

const issue: T.Issue = {
  id: issueId("i1"),
  number: 1,
  title: "watch",
  description: "",
  priority: "medium",
  deliver: "change",
  createdAt: 0,
  mandate: { strength: "explicit", maxBotReviewRounds: 3, autoSubmitPr: false },
  assignments: [{ id: "a", issue: issueId("i1"), agent: "lab", assignedAt: 0, executions: [{ kind: "worker", session: sessionId("w1"), startedAt: 0 }] }],
  status: "in_progress",
  stage: { state: "working", acts: [] },
  moves: [],
  blockedBy: [],
  findings: [],
  questions: [],
  criteria: [],
  checks: [],
};
const event = (seq: number, revision = 0): T.SessionEvent => ({ seq, revision, time: 0, type: "assistant/message", text: "hello" });
const newCore = () => makeCore({ projection: { reduce, effects: effectsOf, frame: makeFrameOf() }, clock: wallTime });
const log = keptLog();

/** The first n rows the watch gives, or fewer if it ends first. */
async function taken(rows: AsyncIterable<T.IssueWatch>, n: number): Promise<T.IssueWatch[]> {
  const out: T.IssueWatch[] = [];
  if (n === 0) return out;
  for await (const r of rows) {
    out.push(r);
    if (out.length >= n) break;
  }
  return out;
}

/** The rows up to and with the first state row. */
async function untilState(rows: AsyncIterable<T.IssueWatch>): Promise<T.IssueWatch[]> {
  const out: T.IssueWatch[] = [];
  for await (const r of rows) {
    out.push(r);
    if (r.kind === "state") break;
  }
  return out;
}

async function firstFrame(frames: AsyncIterable<T.StateFrame>): Promise<T.StateFrame> {
  for await (const f of frames) return f;
  throw new Error("the core gave no frame");
}

describe("issue observation", () => {
  it("regression: subscription retains a revision arriving while history is read", async () => {
    const core = newCore();
    core.apply({ type: "issueChanged", issue });
    const rows = await taken(
      watchIssue(
        issue,
        core,
        {
          events: async () => {
            core.sessionEvent(sessionId("w1"), event(700, 1));
            return [event(700)];
          },
        },
        log,
      ),
      4,
    );
    expect(rows.some((r) => r.kind === "history" && r.events[0]?.revision === 0)).toBe(true);
    expect(rows.some((r) => r.kind === "event" && r.event.revision === 1)).toBe(true);
    expect(rows.some((r) => r.kind === "gap" && r.before === 700)).toBe(true);
    core.close();
  });

  it("regression: reset frame sequence still follows a new execution session", async () => {
    const core = newCore();
    core.apply({ type: "issueChanged", issue });
    const frame = await firstFrame(core.states());
    const next: T.Issue = { ...issue, assignments: [{ ...issue.assignments[0]!, executions: [{ kind: "worker", session: sessionId("w2"), startedAt: 2 }] }] };
    async function* states(): AsyncGenerator<T.StateFrame> {
      yield { ...frame, seq: 700 };
      yield { ...frame, seq: 0, state: { ...frame.state, issues: [next] } };
    }
    const rows = await taken(
      watchIssue(issue, { subscribe: () => new Hub<T.ServerEvent>().subscribe(), states }, { events: async (id) => [event(id === "w1" ? 700 : 0)] }, log),
      5,
    );
    expect(rows.filter((r) => r.kind === "state").map((r) => r.issue.assignments[0]?.executions[0]?.session)).toEqual(["w1", "w2"]);
    expect(rows.filter((r) => r.kind === "history").map((r) => r.session)).toEqual(["w1", "w2"]);
    core.close();
  });
  it("regression: observation bounds sessions and retained history with explicit truncation", async () => {
    const core = newCore();
    const many: T.Issue = {
      ...issue,
      assignments: [
        { ...issue.assignments[0]!, executions: Array.from({ length: 12 }, (_, i) => ({ kind: "worker", session: sessionId("w" + i), startedAt: i })) },
      ],
    };
    core.apply({ type: "issueChanged", issue: many });
    const read: string[] = [];
    const rows = await untilState(
      watchIssue(
        many,
        core,
        {
          events: async (id) => {
            read.push(id);
            return Array.from({ length: 1000 }, (_, n) => event(n));
          },
        },
        log,
      ),
    );
    expect(read).toHaveLength(8);
    expect(read[0]).toBe("w4");
    expect(rows.filter((r) => r.kind === "history").every((r) => r.events.length === 241)).toBe(true);
    expect(rows.filter((r) => r.kind === "gap")).toHaveLength(8);
    expect(rows.at(-1)).toMatchObject({ kind: "state", omittedSessions: 4 });
    core.close();
  });
  it("regression: an expired archived journal is reported as unavailable", async () => {
    const core = newCore();
    const closed: T.Issue = { ...issue, closedAt: 1, status: "done", stage: { state: "done", acts: [] } };
    const rows = await untilState(watchIssue(closed, core, { events: async () => [] }, log));
    expect(rows).toContainEqual({ kind: "gap", session: sessionId("w1") });
    expect(rows.at(-1)).toMatchObject({ kind: "state", settled: true });
    core.close();
  });
});
