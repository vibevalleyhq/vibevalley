import { describe, expect, it } from "@effect/vitest";
import { Effect, Fiber, Schema, Sink, Stdio } from "effect";
import { FetchHttpClient } from "effect/http";
import { TestClock } from "effect/testing";

import type { Issue, IssueWatch, SessionEvent } from "@vibevalley/protocol";
import { IssueWatch as WatchSchema, issueId, sessionId } from "@vibevalley/protocol/schema";
import { until } from "@vibevalley/testkit/until";

import { observeIssue } from "./issue-watch.ts";

const issue: Issue = {
  id: issueId("i1"),
  number: 1,
  title: "watch",
  description: "",
  priority: "medium",
  deliver: "change",
  createdAt: 0,
  mandate: { strength: "explicit", maxBotReviewRounds: 3, autoSubmitPr: false },
  assignments: [{ id: "a", issue: issueId("i1"), agent: "lab", assignedAt: 0, executions: [{ kind: "worker", session: sessionId("w1"), startedAt: 0 }] }],
  status: "in_review",
  stage: { state: "reviewing", acts: [] },
  moves: [],
  blockedBy: [],
  findings: [],
  questions: [],
  criteria: [],
  checks: [],
};
const event = (seq: number, revision = 0, run = "one"): SessionEvent => ({ seq, revision, run, time: 0, type: "assistant/message", text: "hello" });
const state: IssueWatch = { kind: "state", issue, sessions: [], sessionIds: [sessionId("w1")], settled: true, omittedSessions: 0 };
const encode = (rows: IssueWatch[]) =>
  Effect.map(
    Effect.forEach(rows, (r) => Schema.encodeEffect(Schema.fromJsonString(WatchSchema))(r)),
    (lines) => lines.map((line) => `data: ${line}\n\n`).join(""),
  );

it.effect("regression: reconnect supplements history once and follow survives handoff until observer cancellation", () =>
  Effect.gen(function* () {
    let attempts = 0;
    let output = "";
    let signal: AbortSignal | undefined;
    const first: IssueWatch[] = [{ kind: "history", session: sessionId("w1"), events: [event(700)] }, state];
    const second: IssueWatch[] = [
      { kind: "history", session: sessionId("w1"), events: [event(700), event(700, 1), event(701, 0, "two")] },
      { ...state, issue: { ...issue, stage: { state: "working", acts: [] } }, settled: false },
    ];
    const [firstBody, secondBody] = [yield* encode(first), yield* encode(second)];
    const fetcher: typeof fetch = (_url, init) => {
      attempts++;
      signal = init?.signal ?? undefined;
      if (attempts === 1) return Promise.resolve(new Response(firstBody));
      return Promise.resolve(
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(secondBody));
            },
          }),
        ),
      );
    };
    const watching = yield* observeIssue("http://127.0.0.1", "i1", true, true).pipe(
      Effect.provide(FetchHttpClient.layer),
      Effect.provideService(FetchHttpClient.Fetch, fetcher),
      Effect.provide(
        Stdio.layerTest({
          stdout: () =>
            Sink.forEach((c: string | Uint8Array) =>
              Effect.sync(() => {
                output += typeof c === "string" ? c : new TextDecoder().decode(c);
              }),
            ),
        }),
      ),
      Effect.forkChild,
    );
    yield* until(() => output.includes('"settled":true'), "first handoff");
    yield* TestClock.adjust("1 second");
    yield* until(() => output.includes('"settled":false'), "reconnected working state");
    expect(attempts).toBe(2);
    expect(output.split("\n").filter((line) => line.includes('"kind":"event"'))).toHaveLength(3);
    expect(output).toContain('"revision":1');
    expect(output).toContain('"run":"two"');
    yield* Fiber.interrupt(watching);
    expect(signal?.aborted).toBe(true);
  }),
);

describe("permanent watch failures", () => {
  it.effect("regression: an invalid stream schema fails without reconnecting forever", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const result = yield* observeIssue("http://127.0.0.1", "i1", false, true).pipe(
        Effect.provide(FetchHttpClient.layer),
        Effect.provideService(FetchHttpClient.Fetch, () => {
          attempts++;
          return Promise.resolve(new Response('data: {"bad":true}\n\n'));
        }),
        Effect.provide(Stdio.layerTest({})),
        Effect.flip,
      );
      expect(result.tag).toBe("WatchProtocol");
      expect(attempts).toBe(1);
    }),
  );
});
