import { expect, test } from "vite-plus/test";

import type { Applied } from "@vibevalley/protocol";

import type { Intent, IntentAt } from "#/state/intent.ts";

import { sampleIssue } from "./issue.samples";
import { type IssueSaid, type IssueSet, labeledIssue, pendingWords } from "./write";

const said = (
  key: string,
  id: string,
  over: Partial<Pick<Intent<IssueSaid, Applied>, "key" | "input">> & ({ readonly phase?: "sending" } | IntentAt<Applied>) = {},
): Intent<IssueSaid, Applied> => ({
  key,
  input: { id, text: `说给 ${id}` },
  phase: "sending",
  ...over,
});

test("words said on an issue show under its box, sending or refused with why, and only on that issue", () => {
  const words = pendingWords(
    [said("a", "i1"), said("b", "i2"), said("c", "i1", { phase: "failed", fault: { tag: "Network", reason: "没连上", retryable: true } })],
    "i1",
  );
  expect(words).toEqual([
    { key: "a", text: "说给 i1", state: "sending" },
    { key: "c", text: "说给 i1", state: "failed", reason: "没连上" },
  ]);
});

test("a label the user set shows on the issue while on its way, and the frame's again, marked, once refused", () => {
  const set = (input: IssueSet, status: "pending" | "failed" = "pending"): Intent<IssueSet, never> => ({
    key: input.id,
    input,
    ...(status === "failed" ? { phase: "failed", fault: { tag: "Refused", reason: "", retryable: false } } : { phase: "sending" }),
  });
  const issue = sampleIssue(1, "旧标题", "in_progress", "medium", { deliver: "change" });
  const shown = (sets: Intent<IssueSet, never>[]) => {
    const i = labeledIssue(issue, sets).issue;
    return [i.title, i.priority, i.deliver];
  };
  expect(shown([])).toEqual(["旧标题", "medium", "change"]);
  expect(shown([set({ id: "i1", title: "新标题" }), set({ id: "i1", priority: "urgent" })])).toEqual(["新标题", "urgent", "change"]);
  expect(shown([set({ id: "i1", deliver: "answer" }, "failed"), set({ id: "i2", title: "别的" })])).toEqual(["旧标题", "medium", "change"]);
  expect(labeledIssue(issue, [set({ id: "i1", title: "新标题" })]).state("title")).toBe("pending");
  expect(labeledIssue(issue, [set({ id: "i1", deliver: "answer" }, "failed")]).state("deliver")).toBe("failed");
  expect(labeledIssue(issue, [set({ id: "i1", title: "新标题" })]).state("priority")).toBeUndefined();
});
