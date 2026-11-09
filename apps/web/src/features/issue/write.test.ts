import { expect, test } from "vite-plus/test";

import type { Applied } from "@vibevalley/protocol";

import type { Intent, IntentAt } from "#/state/intent.ts";

import { type DeliverPick, type IssueSaid, pendingWords, shownDeliver } from "./write";

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

test("the deliver pick shows the owner's choice on its way, and the frame's again, marked, once refused", () => {
  const pick = (status: "pending" | "failed"): Intent<DeliverPick, never> => ({
    key: "k",
    input: { id: "i1", deliver: "answer" },
    ...(status === "failed" ? { phase: "failed", fault: { tag: "Refused", reason: "", retryable: false } } : { phase: "sending" }),
  });
  expect(shownDeliver("i1", "change", [])).toEqual({ value: "change" });
  expect(shownDeliver("i1", "change", [pick("pending")])).toEqual({ value: "answer", state: "pending" });
  expect(shownDeliver("i1", "change", [pick("failed")])).toEqual({ value: "change", state: "failed" });
  expect(shownDeliver("i2", "branch", [pick("pending")])).toEqual({ value: "branch" });
});
