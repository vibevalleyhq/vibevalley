import "../../../infra/polyfill";
import { expect, test } from "nsh/test";

import type { ChatMessage, IssueId, MessageId, Milestone, Run, SessionId } from "@vibevalley/protocol";

import { mergeIssueActivity, remainingMessageAttachments } from "./activity";

function makeMessage(overrides: Partial<Omit<ChatMessage, "id">> & { id: string; at: number; number: number; text: string }): ChatMessage {
  return {
    channel: "ch-1",
    from: "user",
    name: "User",
    actor: { kind: "user", id: "user" },
    kind: "chat",
    outcome: null,
    spoken: false,
    revision: 1,
    attachments: [],
    embeds: [],
    reactions: [],
    mentions: [],
    ...overrides,
    id: overrides.id as MessageId,
  };
}

function makeRun(id: string, startedAt: number, endedAt?: number): Run {
  return {
    needsReconciliation: false,
    id,
    session: "s1" as SessionId,
    issue: "i1" as IssueId,
    triggeredBy: { kind: "issue" },
    heard: [],
    startedAt,
    ...(endedAt !== undefined ? { endedAt, outcome: "completed" as const } : {}),
    summary: "",
  };
}

test("mergeIssueActivity orders milestones and messages oldest-first and attaches run steps once per run", () => {
  const milestones: Milestone[] = [
    { at: 100, kind: "opened", text: "Opened" },
    { at: 200, kind: "started", who: "helper", text: "Started", run: "r1" },
    { at: 400, kind: "reported", who: "helper", text: "Handed back", said: "Implemented fix", run: "r1" },
    { at: 500, kind: "started", who: "helper", text: "You told it something; another round", run: "r2" },
  ];
  const messages: ChatMessage[] = [
    makeMessage({ id: "m1", at: 150, number: 1, text: "Initial context" }),
    makeMessage({ id: "m-deleted", at: 250, number: 2, text: "Should hide", deleted: 260 }),
    makeMessage({ id: "m2", at: 300, number: 3, text: "Please add tests too" }),
    makeMessage({ id: "m3", at: 500, number: 4, text: "Follow-up instruction" }),
  ];
  const runs: Run[] = [makeRun("r1", 200, 400), makeRun("r2", 500)];

  const merged = mergeIssueActivity(milestones, messages, runs);
  expect(merged.map((x) => (x.kind === "milestone" ? `ms:${x.milestone.kind}:${x.milestone.run ?? ""}` : `msg:${x.message.id}`))).toEqual([
    "ms:opened:",
    "msg:m1",
    "ms:started:r1",
    "msg:m2",
    "ms:reported:r1",
    "msg:m3",
    "ms:started:r2",
  ]);

  // Deleted message is excluded.
  expect(merged.some((x) => x.kind === "message" && x.message.id === "m-deleted")).toBe(false);

  // Run r1 attaches expandable steps only on its terminal reported milestone, not started.
  const r1Start = merged.find((x) => x.kind === "milestone" && x.milestone.kind === "started" && x.milestone.run === "r1");
  const r1Report = merged.find((x) => x.kind === "milestone" && x.milestone.kind === "reported");
  expect(r1Start?.kind === "milestone" && r1Start.attachRunSteps).toBe(false);
  expect(r1Report?.kind === "milestone" && r1Report.attachRunSteps).toBe(true);
  expect(r1Report?.kind === "milestone" && r1Report.run?.id).toBe("r1");

  // Active run r2 has only a started milestone, so steps attach there.
  const r2Start = merged.find((x) => x.kind === "milestone" && x.milestone.run === "r2");
  expect(r2Start?.kind === "milestone" && r2Start.attachRunSteps).toBe(true);
  expect(r2Start?.kind === "milestone" && r2Start.run?.id).toBe("r2");
});

test("mergeIssueActivity places opened before same-timestamp comments and assigns unique stable keys", () => {
  const milestones: Milestone[] = [
    { at: 100, kind: "opened", text: "Opened" },
    { at: 200, kind: "started", who: "helper", text: "Started", run: "r1" },
    { at: 200, kind: "reported", who: "helper", text: "Handed back", run: "r1" },
    { at: 300, kind: "rejected", text: "Sent back: fix A" },
    { at: 300, kind: "rejected", text: "Sent back: fix B" },
  ];
  const messages: ChatMessage[] = [
    makeMessage({ id: "m1", at: 100, number: 1, text: "Same timestamp as opened" }),
    makeMessage({ id: "m2", at: 200, number: 2, text: "Same timestamp as r1" }),
  ];

  const merged = mergeIssueActivity(milestones, messages, []);
  expect(merged.map((x) => (x.kind === "milestone" ? x.milestone.kind : x.message.id))).toEqual([
    "opened",
    "m1",
    "m2",
    "started",
    "reported",
    "rejected",
    "rejected",
  ]);
  const keys = merged.map((x) => x.key);
  expect(new Set(keys).size).toBe(keys.length);
});

test("remainingMessageAttachments deduplicates inline markdown attachment images", () => {
  const att1 = { id: "att-1", name: "one.png", type: "image/png", size: 100 };
  const att2 = { id: "att-2", name: "two.pdf", type: "application/pdf", size: 200 };
  expect(remainingMessageAttachments({ text: "![img](/api/v1/attachment/att-1)", attachments: [att1, att2] })).toEqual([att2]);
  expect(remainingMessageAttachments({ text: "![img](/api/v1/attachment/att-1)", attachments: [att1] })).toBeUndefined();
});
