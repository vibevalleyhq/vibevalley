import { describe, expect, it } from "vite-plus/test";

import type { Issue, IssueWatch, SessionEvent } from "@vibevalley/protocol";
import { issueId, sessionId } from "@vibevalley/protocol/schema";
import { until } from "@vibevalley/testkit/until";

import type { Io } from "#/base/output.ts";

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
const encode = (rows: IssueWatch[]) => rows.map((r) => `data: ${JSON.stringify(r)}\n\n`).join("");

/** An io whose waits end only when the test moves time on (tick), as a test clock's do. */
const ioOf = (fetcher: typeof fetch, write: (text: string) => void, signal: AbortSignal) => {
  const waiting: (() => void)[] = [];
  const io: Io = {
    stdout: write,
    stderr: () => undefined,
    stdin: () => Promise.resolve(""),
    stdoutIsTerminal: false,
    env: {},
    fetch: fetcher,
    clock: {
      now: () => 0,
      sleep: (_ms, s) =>
        new Promise<void>((resolve, reject) => {
          if (s?.aborted === true) return reject(s.reason);
          waiting.push(resolve);
          s?.addEventListener("abort", () => reject(s.reason), { once: true });
        }),
    },
    signal,
  };
  return { io, waits: () => waiting.length, tick: () => waiting.splice(0).forEach((go) => go()) };
};

it("regression: reconnect supplements history once and follow survives handoff until observer cancellation", async () => {
  let attempts = 0;
  let output = "";
  let signal: AbortSignal | undefined;
  const first: IssueWatch[] = [{ kind: "history", session: sessionId("w1"), events: [event(700)] }, state];
  const second: IssueWatch[] = [
    { kind: "history", session: sessionId("w1"), events: [event(700), event(700, 1), event(701, 0, "two")] },
    { ...state, issue: { ...issue, stage: { state: "working", acts: [] } }, settled: false },
  ];
  const [firstBody, secondBody] = [encode(first), encode(second)];
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
  const observer = new AbortController();
  const { io, waits, tick } = ioOf(
    fetcher,
    (text) => {
      output += text;
    },
    observer.signal,
  );
  const watching = observeIssue(io, "http://127.0.0.1", "i1", true, true).catch((e: unknown) => e);
  await until(() => output.includes('"settled":true'), "first handoff");
  await until(() => waits() > 0, "the wait before reconnecting");
  tick();
  await until(() => output.includes('"settled":false'), "reconnected working state");
  expect(attempts).toBe(2);
  expect(output.split("\n").filter((line) => line.includes('"kind":"event"'))).toHaveLength(3);
  expect(output).toContain('"revision":1');
  expect(output).toContain('"run":"two"');
  observer.abort();
  await watching;
  expect(signal?.aborted).toBe(true);
});

describe("permanent watch failures", () => {
  it("regression: an invalid stream schema fails without reconnecting forever", async () => {
    let attempts = 0;
    const { io } = ioOf(
      () => {
        attempts++;
        return Promise.resolve(new Response('data: {"bad":true}\n\n'));
      },
      () => undefined,
      new AbortController().signal,
    );
    const result = await observeIssue(io, "http://127.0.0.1", "i1", false, true).catch((e: unknown) => e);
    expect(result).toMatchObject({ tag: "WatchProtocol" });
    expect(attempts).toBe(1);
  });
});
