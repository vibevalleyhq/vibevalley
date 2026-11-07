import { NodeServices } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import { Effect, Layer, Queue, Stream } from "effect";

import type * as T from "@vibevalley/protocol";
import { issueId, sessionId } from "@vibevalley/protocol/schema";

import { Core } from "#/core/core.ts";
import { ServerConfig } from "#/infra/config.ts";
import { layer as projection } from "#/projection/frame.ts";
import { testConfig } from "#/testing/layers.ts";

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
const layer = Core.layer.pipe(Layer.provide(projection), Layer.provide(Layer.succeed(ServerConfig, testConfig())), Layer.provide(NodeServices.layer));

describe("issue observation", () => {
  it.effect("regression: subscription retains a revision arriving while history is read", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      yield* core.apply({ type: "issueChanged", issue });
      const queue = yield* watchIssue(issue, core, {
        events: () =>
          Effect.gen(function* () {
            yield* core.sessionEvent("w1", event(700, 1));
            return [event(700)];
          }),
      }).pipe(Stream.take(4), Stream.toQueue({ capacity: 8 }));
      const rows = yield* Queue.takeN(queue, 4);
      expect(rows.some((r) => r.kind === "history" && r.events[0]?.revision === 0)).toBe(true);
      expect(rows.some((r) => r.kind === "event" && r.event.revision === 1)).toBe(true);
      expect(rows.some((r) => r.kind === "gap" && r.before === 700)).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("regression: reset frame sequence still follows a new execution session", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      yield* core.apply({ type: "issueChanged", issue });
      const frame = yield* core.states.pipe(Stream.take(1), Stream.runCollect);
      const initial = frame[0]!;
      const next: T.Issue = { ...issue, assignments: [{ ...issue.assignments[0]!, executions: [{ kind: "worker", session: sessionId("w2"), startedAt: 2 }] }] };
      const states = Stream.fromIterable<T.StateFrame>([
        { ...initial, seq: 700 },
        { ...initial, seq: 0, state: { ...initial.state, issues: [next] } },
      ]);
      const rows = yield* watchIssue(
        issue,
        { subscribe: Effect.succeed(Stream.never), states },
        { events: (id) => Effect.succeed([event(id === "w1" ? 700 : 0)]) },
      ).pipe(Stream.take(5), Stream.runCollect);
      expect(rows.filter((r) => r.kind === "state").map((r) => r.issue.assignments[0]?.executions[0]?.session)).toEqual(["w1", "w2"]);
      expect(rows.filter((r) => r.kind === "history").map((r) => r.session)).toEqual(["w1", "w2"]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
  it.effect("regression: observation bounds sessions and retained history with explicit truncation", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      const many: T.Issue = {
        ...issue,
        assignments: [
          { ...issue.assignments[0]!, executions: Array.from({ length: 12 }, (_, i) => ({ kind: "worker", session: sessionId("w" + i), startedAt: i })) },
        ],
      };
      yield* core.apply({ type: "issueChanged", issue: many });
      const read: string[] = [];
      const rows = yield* watchIssue(many, core, {
        events: (id) =>
          Effect.sync(() => {
            read.push(id);
            return Array.from({ length: 1000 }, (_, n) => event(n));
          }),
      }).pipe(
        Stream.takeUntil((r) => r.kind === "state"),
        Stream.runCollect,
      );
      expect(read).toHaveLength(8);
      expect(read[0]).toBe("w4");
      expect(rows.filter((r) => r.kind === "history").every((r) => r.events.length === 241)).toBe(true);
      expect(rows.filter((r) => r.kind === "gap")).toHaveLength(8);
      expect(rows.at(-1)).toMatchObject({ kind: "state", omittedSessions: 4 });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
  it.effect("regression: an expired archived journal is reported as unavailable", () =>
    Effect.gen(function* () {
      const core = yield* Core;
      const closed: T.Issue = { ...issue, closedAt: 1, status: "done", stage: { state: "done", acts: [] } };
      const rows = yield* watchIssue(closed, core, { events: () => Effect.succeed([]) }).pipe(
        Stream.takeUntil((r) => r.kind === "state"),
        Stream.runCollect,
      );
      expect(rows).toContainEqual({ kind: "gap", session: "w1" });
      expect(rows.at(-1)).toMatchObject({ kind: "state", settled: true });
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );
});
