import { expect, test } from "vite-plus/test";

import { clockText, dayClock, duskOf, sunOf } from "../src/clock";

test("a day of 60 seconds moves a quarter in 15 seconds, faster when sped up, not at all when paused", () => {
  const clock = dayClock({ daySeconds: 60, start: 0 });
  const seen: number[] = [];
  clock.subscribe((d) => seen.push(d.tod));
  clock.advance(15);
  expect(clock.day().tod).toBeCloseTo(0.25);
  clock.setSpeed(2);
  clock.advance(15);
  expect(clock.day().tod).toBeCloseTo(0.75);
  clock.setSpeed(0);
  clock.advance(15);
  expect(clock.day()).toMatchObject({ tod: 0.75, paused: true, speed: 2 });
  clock.setSpeed(1);
  clock.advance(30);
  expect(clock.day().tod).toBeCloseTo(0.25, 5);
  expect(seen.length).toBeGreaterThan(3);
});

test("the time of day wraps into 0..1", () => {
  const clock = dayClock({ daySeconds: 60 });
  clock.setTimeOfDay(1.5);
  expect(clock.day().tod).toBeCloseTo(0.5);
  clock.setTimeOfDay(-0.25);
  expect(clock.day().tod).toBeCloseTo(0.75);
});

test("full sun at noon, none at midnight, dusk at sunrise and sunset", () => {
  expect(sunOf(0.5)).toBe(1);
  expect(sunOf(0)).toBe(0);
  expect(duskOf(0.26)).toBe(1);
  expect(duskOf(0.5)).toBe(0);
  expect(clockText(0.5)).toBe("12:00");
  expect(clockText(0.3)).toBe("07:10");
});
