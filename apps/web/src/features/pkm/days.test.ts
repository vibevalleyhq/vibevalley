import { expect, test } from "vite-plus/test";

import { dayKey, daysUntil, dayTitle, monthWeeks } from "./days";

test("a journal's title in the user's words, with the year only when it is another", () => {
  expect(dayTitle("2026-11-03", "2026-11-04", "zh")).toBe("11月3日周二");
  expect(dayTitle("2025-12-31", "2026-11-04", "en")).toBe("Wed, December 31, 2025");
  expect(dayTitle("not a day", "2026-11-04")).toBeUndefined();
});

test("days until a deadline, negative once it is past", () => {
  expect(daysUntil("2026-11-15", "2026-11-04")).toBe(11);
  expect(daysUntil("2026-11-04", "2026-11-04")).toBe(0);
  expect(daysUntil("2026-11-01", "2026-11-04")).toBe(-3);
  expect(daysUntil("someday", "2026-11-04")).toBeUndefined();
});

test("a month's weeks start on Monday and are filled out with the months around it", () => {
  const weeks = monthWeeks(2026, 10);
  expect(weeks).toHaveLength(6);
  expect(weeks[0]?.map((d) => d.day)).toEqual(["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]);
  expect(weeks[0]?.[6]?.inMonth).toBe(true);
  expect(weeks.at(-1)?.[0]).toEqual({ day: "2026-11-30", inMonth: true });
  expect(weeks.at(-1)?.at(-1)).toEqual({ day: "2026-12-06", inMonth: false });
});

test.each([
  ["2026-11-17", "2026-11-18"],
  ["2026-11-30", "2026-12-01"],
  ["2026-12-31", "2027-01-01"],
])("explicit local time crosses midnight from %s to %s", (before, after) => {
  const midnight = new Date(`${after}T00:00:00.000`).getTime();
  expect(dayKey(midnight - 1)).toBe(before);
  expect(dayKey(midnight)).toBe(after);
  expect(daysUntil(after, before)).toBe(1);
});

test("the calendar's year boundary includes both adjacent journals", () => {
  const december = monthWeeks(2026, 11).flat();
  const january = monthWeeks(2027, 0).flat();
  expect(december).toContainEqual({ day: "2026-12-31", inMonth: true });
  expect(december).toContainEqual({ day: "2027-01-01", inMonth: false });
  expect(january).toContainEqual({ day: "2026-12-31", inMonth: false });
  expect(january).toContainEqual({ day: "2027-01-01", inMonth: true });
  expect(dayTitle("2026-12-31", "2027-01-01", "en")).toBe("Thu, December 31, 2026");
});
