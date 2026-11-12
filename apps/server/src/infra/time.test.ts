import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { wallTime } from "./time.ts";

afterEach(() => {
  vi.useRealTimers();
});

describe("the wall Time", () => {
  test("reads, waits and fires as the timers move", async () => {
    vi.useFakeTimers({ now: 1_000 });
    const time = wallTime;
    expect(time.now()).toBe(1_000);
    const fired: string[] = [];
    time.after(500, () => fired.push("after"));
    const cancel = time.after(500, () => fired.push("canceled"));
    cancel();
    const slept = time.sleep(500).then(() => fired.push("slept"));
    await vi.advanceTimersByTimeAsync(499);
    expect(fired).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    await slept;
    expect(fired.toSorted()).toEqual(["after", "slept"]);
    expect(time.now()).toBe(1_500);
  });
});
