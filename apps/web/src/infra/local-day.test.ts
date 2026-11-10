import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { localDay, nextLocalMidnight } from "./local-day";

const subscriptions = new Set<() => void>();
let visibility: DocumentVisibilityState;
let document: EventTarget;
const readVisibility = vi.fn(() => visibility);

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  document = new EventTarget();
  Object.defineProperty(document, "visibilityState", { get: readVisibility });
  vi.stubGlobal("document", document);
});

afterEach(() => {
  for (const off of subscriptions) off();
  subscriptions.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function observe() {
  const days: string[] = [];
  const off = localDay.subscribe(() => days.push(localDay.get()));
  subscriptions.add(off);
  return { days, off };
}

test.each([
  ["2026-11-17", "2026-11-18"],
  ["2026-11-30", "2026-12-01"],
  ["2026-12-31", "2027-01-01"],
])("local day subscribers cross midnight from %s to %s", (before, after) => {
  vi.setSystemTime(new Date(`${before}T23:59:59.000`));
  const observed = observe();
  vi.advanceTimersByTime(999);
  expect(observed.days).toEqual([before]);
  vi.advanceTimersByTime(1);
  expect(observed.days).toEqual([before, after]);
  expect(localDay.get()).toBe(after);
});

describe("in a zone with daylight saving", () => {
  // Node reads TZ again when it is set: the days below are 23 and 25 hours long only in such a zone.
  const zone = process.env.TZ;
  beforeAll(() => void (process.env.TZ = "America/New_York"));
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  test.each([
    ["2026-03-08", "2026-03-09", 23],
    ["2026-11-01", "2026-11-02", 25],
  ])("next midnight follows the local calendar across daylight saving on %s", (day, next, hours) => {
    const start = new Date(`${day}T00:00:00.000`).getTime();
    expect(nextLocalMidnight(start)).toBe(new Date(`${next}T00:00:00.000`).getTime());
    expect(nextLocalMidnight(start) - start).toBe(hours * 3_600_000);
  });
});

test("visible resume catches up after days without replaying missed days", () => {
  vi.setSystemTime(new Date("2026-12-30T12:00:00.000"));
  const observed = observe();
  visibility = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  vi.setSystemTime(new Date("2027-01-03T23:59:59.000"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(observed.days).toEqual(["2026-12-30"]);
  visibility = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  expect(observed.days).toEqual(["2026-12-30", "2027-01-03"]);
  document.dispatchEvent(new Event("visibilitychange"));
  expect(observed.days).toEqual(["2026-12-30", "2027-01-03"]);
  vi.advanceTimersByTime(1000);
  expect(observed.days).toEqual(["2026-12-30", "2027-01-03", "2027-01-04"]);
});

test("fresh reads and remounts need no observers while unused", () => {
  vi.setSystemTime(new Date("2026-12-30T12:00:00.000"));
  expect(localDay.get()).toBe("2026-12-30");
  expect(vi.getTimerCount()).toBe(0);
  const first = observe();
  const second = observe();
  first.off();
  vi.setSystemTime(new Date("2026-12-31T23:59:59.000"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(first.days).toEqual(["2026-12-30"]);
  expect(second.days).toEqual(["2026-12-30", "2026-12-31"]);
  second.off();
  expect(vi.getTimerCount()).toBe(0);
  readVisibility.mockClear();
  vi.setSystemTime(new Date("2027-01-03T23:59:59.000"));
  document.dispatchEvent(new Event("visibilitychange"));
  expect(readVisibility).not.toHaveBeenCalled();
  expect(localDay.get()).toBe("2027-01-03");
  expect(vi.getTimerCount()).toBe(0);
  const remounted = observe();
  expect(remounted.days).toEqual(["2027-01-03"]);
  vi.advanceTimersByTime(1000);
  expect(remounted.days).toEqual(["2027-01-03", "2027-01-04"]);
  expect(second.days).toEqual(["2026-12-30", "2026-12-31"]);
  remounted.off();
  expect(vi.getTimerCount()).toBe(0);
  readVisibility.mockClear();
  document.dispatchEvent(new Event("visibilitychange"));
  expect(readVisibility).not.toHaveBeenCalled();
});
