import "../infra/polyfill";
import { describe, expect, open, test } from "nsh/test";

import { setLocale, t } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";

import { SCENARIO_NOW } from "../fixtures/scenarios";
import {
  addIsoDays,
  defaultDatePresets,
  epochMsRangeToIso,
  epochMsToIsoDate,
  isoDateToCommitMs,
  isoDateToEpochMs,
  isoRangeToEpochMs,
  todayIsoDate,
} from "./DatePicker";

describe("design/DatePicker adapters", () => {
  test("converts between UTC epoch ms and ISO YYYY-MM-DD cleanly", () => {
    const nov20 = Date.UTC(2026, 10, 20);
    expect(epochMsToIsoDate(nov20)).toBe("2026-11-20");
    expect(epochMsToIsoDate(Date.UTC(2026, 10, 20, 15, 30))).toBe("2026-11-20");
    expect(epochMsToIsoDate(undefined)).toBeUndefined();
    expect(epochMsToIsoDate(0)).toBeUndefined();
    expect(epochMsToIsoDate(-10)).toBeUndefined();
    expect(epochMsToIsoDate(Number.NaN)).toBeUndefined();

    expect(isoDateToEpochMs("2026-11-20")).toBe(nov20);
    expect(isoDateToEpochMs("2026-11-20T09:30")).toBe(nov20);
    expect(isoDateToEpochMs("")).toBeUndefined();
    expect(isoDateToEpochMs("2026-02-30")).toBeUndefined();
    expect(isoDateToEpochMs("not-a-date")).toBeUndefined();

    expect(isoDateToCommitMs("2026-11-20")).toBe(nov20);
    expect(isoDateToCommitMs(undefined)).toBe(0);
    expect(isoDateToCommitMs("")).toBe(0);

    expect(addIsoDays("2026-11-28", 3)).toBe("2026-12-01");
    expect(addIsoDays("2026-11-20", 7)).toBe("2026-11-27");
    expect(todayIsoDate(SCENARIO_NOW)).toBe("2026-11-20");

    expect(epochMsRangeToIso(nov20, Date.UTC(2026, 10, 25))).toEqual(["2026-11-20", "2026-11-25"]);
    expect(isoRangeToEpochMs(["2026-11-20", "2026-11-25"])).toEqual({
      startAt: nov20,
      dueAt: Date.UTC(2026, 10, 25),
    });
    expect(isoRangeToEpochMs("2026-11-20")).toEqual({ startAt: nov20, dueAt: nov20 });
    expect(isoRangeToEpochMs(undefined)).toEqual({ startAt: undefined, dueAt: undefined });
  });

  test("builds Today / +3d / +1w / Clear presets for single and range modes", () => {
    setLocale("zh");
    const single = defaultDatePresets({ nowMs: SCENARIO_NOW });
    expect(single).toEqual([
      { label: t("web.base.time.today"), value: "2026-11-20" },
      { label: "+3d", value: "2026-11-23" },
      { label: "+1w", value: "2026-11-27" },
      { label: t("web.issue.dates.clearDate"), value: [null, null] },
    ]);

    const range = defaultDatePresets({ range: true, nowMs: SCENARIO_NOW });
    expect(range).toEqual([
      { label: t("web.base.time.today"), value: ["2026-11-20", "2026-11-20"] },
      { label: "+3d", value: ["2026-11-20", "2026-11-23"] },
      { label: "+1w", value: ["2026-11-20", "2026-11-27"] },
      { label: t("web.issue.dates.clearDate"), value: [null, null] },
    ]);
  });
});

describe("design/DatePicker component", () => {
  test("opens downward popup, applies Today/+3d/+1w/Clear presets, picks days, and adapts epoch ms", async () => {
    setLocale("zh");
    const app = await open("./DatePicker.story.tsx", {
      width: 900,
      height: 760,
      colorScheme: "light",
      platform: "macos",
      clock: { time: SCENARIO_NOW },
    });

    expect(app.count("id:datepicker-bench")).toBe(1);
    expect(app.texts()).toContain("2026-11-20");
    expect(app.enabled("id:dp-disabled-trigger")).toBe(false);

    // Open ISO DatePicker popup downward and pick +3d preset -> 2026-11-23.
    await app.press("id:dp-iso-trigger");
    expect(app.texts()).toContain("+3d");
    expect(app.texts()).toContain("+1w");
    await app.press("text:+3d");
    expect(app.shows("id:dp-iso-out >> text:2026-11-23")).toBe(true);

    // Reopen and pick +1w preset -> 2026-11-27.
    await app.press("id:dp-iso-trigger");
    await app.press("text:+1w");
    expect(app.shows("id:dp-iso-out >> text:2026-11-27")).toBe(true);

    // Reopen and pick a specific calendar day (2026-11-25) directly.
    await app.press("id:dp-iso-trigger");
    await app.press("label:2026-11-25");
    expect(app.shows("id:dp-iso-out >> text:2026-11-25")).toBe(true);

    // Reopen and press Clear preset -> clears ISO value.
    await app.press("id:dp-iso-trigger");
    await app.press(`text:${t("web.issue.dates.clearDate")}`);
    expect(app.shows("id:dp-iso-out >> text:none")).toBe(true);

    // Reopen and press Today preset -> 2026-11-20, then clear via sibling clear button.
    await app.press("id:dp-iso-trigger");
    await app.press(`text:${t("web.base.time.today")}`);
    expect(app.shows("id:dp-iso-out >> text:2026-11-20")).toBe(true);
    await app.waitUntil(() => app.count("text:+3d") === 0);
    await app.press("id:dp-iso-clear");
    expect(app.shows("id:dp-iso-out >> text:none")).toBe(true);

    // EpochDatePicker adapts UTC epoch ms and clear -> 0.
    expect(app.shows(`id:dp-epoch-out >> text:${Date.UTC(2026, 10, 20)}`)).toBe(true);
    await app.press("id:dp-epoch-trigger");
    await app.press("text:+3d");
    expect(app.shows(`id:dp-epoch-out >> text:${Date.UTC(2026, 10, 23)}`)).toBe(true);
    await app.waitUntil(() => app.count("text:+3d") === 0);
    await app.press("id:dp-epoch-clear");
    expect(app.shows("id:dp-epoch-out >> text:0")).toBe(true);

    // Range DatePicker picks start and end days.
    await app.press("id:dp-range-trigger");
    await app.press("label:2026-11-18");
    await app.press("label:2026-11-22");
    expect(app.shows("id:dp-range-out >> text:2026-11-18:2026-11-22")).toBe(true);

    // Standalone Calendar picks a day and updates bound value.
    await app.press("id:cal-standalone >> label:2026-10-28");
    expect(app.shows("id:cal-out >> text:2026-10-28")).toBe(true);
  });
});
