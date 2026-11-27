import "../../infra/polyfill";
import { expect, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { SessionEvent } from "@vibevalley/protocol";

import { setCoreBridgeForTest } from "../../infra/rich";
import { collapsedStepSummary, localizeCollapsedSummary, waterfallWidths } from "./runs";

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
