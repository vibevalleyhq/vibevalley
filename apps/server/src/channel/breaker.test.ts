import { expect, it } from "vite-plus/test";
import { WakeBreaker } from "./breaker.ts";

it("trips once after the limit, stays tripped through a word, and opens again when reset", () => {
  const b = new WakeBreaker(2);
  expect(b.failed("w1")).toEqual({ count: 1, tripped: false });
  b.spoke("w1");
  expect(b.failed("w1")).toEqual({ count: 1, tripped: false });
  expect(b.failed("w1")).toEqual({ count: 2, tripped: true });
  expect(b.failed("w1").tripped).toBe(false);
  b.spoke("w1");
  expect([b.isOpen("w1"), b.tripped()]).toEqual([true, ["w1"]]);
  b.reset("w1");
  expect([b.isOpen("w1"), b.tripped()]).toEqual([false, []]);
});
