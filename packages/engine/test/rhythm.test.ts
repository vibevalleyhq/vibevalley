// The timing of a living scene (pixi/rhythm.ts): things that happen every so often, a little irregularly, and the
// wind. Pure, so a made-up random and clock are enough.

import assert from "node:assert/strict";
import { test } from "bun:test";
import { cadence, gust } from "../src/pixi/rhythm";

test("something every so often: never on the first ask, then once per wait, each wait 70–130% of it", () => {
  // A random that always says the middle: the first wait is half, the next ones exactly the asked length.
  const { due } = cadence(() => 0.5);
  assert.equal(due("smoke", 1, 0), false, "the first ask only starts the count");
  assert.equal(due("smoke", 1, 0.4), false);
  assert.equal(due("smoke", 1, 0.5), true);
  assert.equal(due("smoke", 1, 0.6), false, "once, then wait again");
  assert.equal(due("smoke", 1, 1.5), true);
  // Each key keeps its own count.
  assert.equal(due("leaf", 1, 1.5), false);

  let r = 0;
  const ends = cadence(() => r);
  ends.due("x", 10, 0);
  r = 0;
  assert.equal(ends.due("x", 10, 0), true);
  assert.equal(ends.due("x", 10, 6.9), false, "the shortest wait is 70%");
  assert.equal(ends.due("x", 10, 7), true);
});

test("the wind gusts and calms between 0.1 and 1", () => {
  let low = 1;
  let high = 0;
  for (let t = 0; t < 600; t += 0.5) {
    low = Math.min(low, gust(t));
    high = Math.max(high, gust(t));
  }
  assert.ok(low >= 0.1 && low < 0.3, `calmest ${low}`);
  assert.ok(high <= 1 && high > 0.8, `strongest ${high}`);
});
