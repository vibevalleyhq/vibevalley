import { describe, expect, it } from "vite-plus/test";

import { until, untilGot, waitFor, WaitTimedOut } from "./until.ts";

describe("waitFor", () => {
  it("resolves once ok holds", async () => {
    let seen = 0;
    const answer = await waitFor(
      () => ++seen,
      (n) => n >= 3,
      "three reads",
      200,
    );
    expect(answer).toBe(3);
  });

  it("times out with WaitTimedOut naming what when ok never holds", async () => {
    await expect(
      waitFor(
        () => false,
        (held) => held,
        () => "the gate",
        20,
      ),
    ).rejects.toThrow(new WaitTimedOut("waited for the gate"));
  });

  it("times out within its deadline even when get never settles", async () => {
    const hung = () => new Promise<boolean>(() => {});
    const started = performance.now();
    await expect(until(hung, "a stalled reader", 25)).rejects.toThrow(new WaitTimedOut("waited for a stalled reader"));
    expect(performance.now() - started).toBeLessThan(250);
    await expect(untilGot(() => new Promise<string | undefined>(() => {}), "a stalled value", 25)).rejects.toThrow(
      new WaitTimedOut("waited for a stalled value"),
    );
  });
});
