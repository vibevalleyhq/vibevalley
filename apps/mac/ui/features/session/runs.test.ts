import "../../infra/polyfill";
import { expect, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { SessionEvent } from "@vibevalley/protocol";

import { setCoreBridgeForTest } from "../../infra/rich";
import { collapsedStepSummary, localizeCollapsedSummary, waterfallWidths } from "./runs";
import { computeRunDurationMs, computeTrajectoryDurations, emptySummary, sanitizeTrajectorySummary } from "./trajectory/model";

test("waterfallWidths handles empty/non-positive room and forwards Rust VvCore widths", () => {
  expect(waterfallWidths([], 400)).toEqual([]);
  expect(waterfallWidths([100, 200], 0)).toEqual([]);
  expect(waterfallWidths([100, 200], -10)).toEqual([]);
  expect(waterfallWidths([0, 0, 0], 300)).toEqual([100, 100, 100]);

  const restore = setCoreBridgeForTest({
    waterfallWidths: () => JSON.stringify([48, 512]),
  });
  try {
    expect(waterfallWidths([11_000, 27_360_000], 560)).toEqual([48, 512]);
  } finally {
    restore();
  }
});

test("localizeCollapsedSummary and collapsedStepSummary localize API-key errors and context-update fallback", () => {
  setLocale("zh");
  expect(localizeCollapsedSummary("")).toBe(t("web.session.trajectory.contextUpdate"));
  expect(localizeCollapsedSummary("#general:1 · w1 Ada #4: no API key is set for the model")).toBe(
    `#general:1 · w1 Ada #4: ${t("web.issue.error.missingApiKey")}`,
  );

  const userStep: SessionEvent = { seq: 1, type: "user/message", text: "Fix\n  timeout", time: 1_000, revision: 1 };
  expect(collapsedStepSummary(userStep, userStep.text)).toBe("Fix timeout");

  const restore = setCoreBridgeForTest({
    collapsedStepSummary: () => "帮我把登录超时修一下",
  });
  try {
    expect(collapsedStepSummary(userStep, "raw scaffolding")).toBe("帮我把登录超时修一下");
  } finally {
    restore();
  }
});

test("computeTrajectoryDurations and sanitizeTrajectorySummary exclude inter-turn idle hours and unclosed historical spans", () => {
  const HOUR = 3_600_000;
  const MIN = 60_000;

  // 1. Multi-turn session without distinct `run` ids or `llm/usage` separated by 12 hours 5 minutes.
  const multiTurnNoRun: SessionEvent[] = [
    { seq: 1, type: "user/message", text: "first", time: 1_000, revision: 1 },
    { seq: 2, type: "assistant/message", text: "done 1", time: 6_000, revision: 1 },
    { seq: 3, type: "user/message", text: "second", time: 1_000 + 12 * HOUR + 5 * MIN, revision: 1 },
    { seq: 4, type: "assistant/message", text: "done 2", time: 5_000 + 12 * HOUR + 5 * MIN, revision: 1 },
  ];
  const d1 = computeTrajectoryDurations(multiTurnNoRun, false, 1_000 + 12 * HOUR + 10 * MIN);
  expect(d1).toEqual({ modelMs: 9_000, toolMs: 0 });
  expect(computeRunDurationMs(multiTurnNoRun, false, 1_000 + 12 * HOUR + 10 * MIN)).toBe(9_000);

  // 2. Resting/completed run viewed 12 hours later with a late synthetic endMs and an unmatched tool/call.
  const completedWithOpenTool: SessionEvent[] = [
    { seq: 1, run: "r1", type: "user/message", text: "run tests", time: 10_000, revision: 1 },
    { seq: 2, run: "r1", type: "assistant/thinking", text: "thinking", time: 12_000, revision: 1 },
    { seq: 3, run: "r1", type: "tool/call", tool: "run_command", text: "test", time: 13_000, revision: 1 },
    { seq: 4, run: "r1", type: "tool/result", call: 3, ok: true, output: "ok", text: "", time: 15_500, revision: 1 },
    { seq: 5, run: "r1", type: "assistant/message", text: "all green", time: 16_500, revision: 1 },
    { seq: 6, run: "r1", type: "tool/call", tool: "cleanup", text: "cleanup", time: 16_500, revision: 1 },
  ];
  const inflatedServerSummary = { ...emptySummary, runs: 1, steps: 5, modelMs: 12 * HOUR + 5 * MIN, toolMs: 12 * HOUR };
  const sanitized = sanitizeTrajectorySummary(inflatedServerSummary, completedWithOpenTool, false, 10_000 + 12 * HOUR + 5 * MIN);
  expect(sanitized.modelMs).toBe(4_000);
  expect(sanitized.toolMs).toBe(2_500);

  // 3. Overnight pause gap (> 30m) between user/message and assistant/thinking does not count idle hours as model time.
  const overnightPause: SessionEvent[] = [
    { seq: 1, run: "r1", type: "user/message", text: "queued overnight", time: 1_000, revision: 1 },
    { seq: 2, run: "r1", type: "assistant/thinking", text: "resumed", time: 1_000 + 12 * HOUR, revision: 1 },
    { seq: 3, run: "r1", type: "assistant/message", text: "finished", time: 4_000 + 12 * HOUR, revision: 1 },
  ];
  expect(computeTrajectoryDurations(overnightPause, false, 5_000 + 12 * HOUR)).toEqual({ modelMs: 3_000, toolMs: 0 });
});
