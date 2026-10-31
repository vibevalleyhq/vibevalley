import { expect, it } from "vite-plus/test";

import { PoseHold, poseMinMs } from "./pose";

it("shows the first pose at once, then keeps each at least 800 ms", () => {
  const hold = new PoseHold("work", 0);
  expect(hold.next("idle", 100)).toBe("work");
  expect(hold.next("work", 200)).toBe("work");
  expect(hold.next("idle", poseMinMs - 1)).toBe("work");
  expect(hold.next("idle", poseMinMs)).toBe("idle");
});

it("keeps only the newest of a burst, and catches up within one window", () => {
  const hold = new PoseHold("work", 0);
  for (const [want, at] of [
    ["idle", 100],
    ["think", 200],
    ["cheer", 300],
    ["idle", 400],
  ] as const)
    expect(hold.next(want, at)).toBe("work");
  expect(hold.next("idle", 799)).toBe("work");
  expect(hold.next("idle", 800)).toBe("idle");
  expect(hold.next("idle", 1_600)).toBe("idle");
});
