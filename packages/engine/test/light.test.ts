// The pure half of the light and the yard (pixi/normals.ts, pixi/sky.ts, pixi/material.ts): normal maps made from
// pictures, the sky through a day, and what a painted pixel is made of. The rest (the passes and the filter) is
// looked at on the pixel page.

import assert from "node:assert/strict";

import { test } from "vite-plus/test";

import { materialOf } from "../src/pixi/material";
import { GROUND_NORMALS, mirrorNormals, normalsOf, SPRITE_NORMALS } from "../src/pixi/normals";
import { flatLight, skyAt } from "../src/pixi/sky";

/** A w×h picture: `solid` says which pixels are painted (grey, opaque); the rest are clear. */
function picture(w: number, h: number, solid: (x: number, y: number) => boolean, grey = 128): Uint8ClampedArray {
  const px = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!solid(x, y)) continue;
      px.set([grey, grey, grey, 255], (y * w + x) * 4);
    }
  }
  return px;
}

const at = (normals: Uint8ClampedArray, w: number, x: number, y: number) => Array.from(normals.slice((y * w + x) * 4, (y * w + x) * 4 + 4));

test("a painted blob rounds like a pillow: its middle faces the viewer, its edges face outwards", () => {
  const w = 9;
  const normals = normalsOf(
    picture(w, 9, (x, y) => x >= 1 && x <= 7 && y >= 1 && y <= 7),
    w,
    9,
    { ...SPRITE_NORMALS, relief: 0 },
  );
  assert.deepEqual(at(normals, w, 4, 4), [128, 128, 255, 255], "the middle, flat");
  const [lx, ly] = at(normals, w, 1, 4);
  assert.ok(lx !== undefined && lx < 110 && Math.abs((ly ?? 0) - 128) <= 1, "the left edge faces left");
  const [rx] = at(normals, w, 7, 4);
  assert.ok(rx !== undefined && rx > 146, "the right edge faces right");
  const [, ty] = at(normals, w, 4, 1);
  assert.ok(ty !== undefined && ty < 110, "the top edge faces up the screen");
  assert.equal(at(normals, w, 0, 0)[3], 0, "clear stays clear");
});

test("flat ground of one colour is flat; the painting gives it relief", () => {
  const w = 6;
  const plain = normalsOf(
    picture(w, 6, () => true),
    w,
    6,
    GROUND_NORMALS,
  );
  for (let i = 0; i < plain.length; i += 4) assert.deepEqual(Array.from(plain.slice(i, i + 3)), [128, 128, 255]);
  // A light stripe down the middle stands up from darker ground on either side.
  const striped = new Uint8ClampedArray(w * 6 * 4);
  for (let y = 0; y < 6; y++) for (let x = 0; x < w; x++) striped.set(x === 3 ? [240, 240, 240, 255] : [40, 40, 40, 255], (y * w + x) * 4);
  const [left] = at(normalsOf(striped, w, 6, GROUND_NORMALS), w, 2, 3);
  assert.ok(left !== undefined && left < 128, "the slope up to the stripe faces left");
});

test("drawn mirrored, a pixel faces the other way, nothing else changes", () => {
  const w = 9;
  const normals = normalsOf(
    picture(w, 9, (x, y) => x >= 1 && x <= 7 && y >= 1 && y <= 7),
    w,
    9,
    SPRITE_NORMALS,
  );
  const mirrored = mirrorNormals(normals);
  for (let i = 0; i < normals.length; i += 4) {
    assert.equal(mirrored[i], 255 - (normals[i] ?? 0));
    assert.deepEqual(Array.from(mirrored.slice(i + 1, i + 4)), Array.from(normals.slice(i + 1, i + 4)));
  }
});

test("at midday flat ground comes out as painted; the sun crosses from the left to the right", () => {
  const noon = flatLight(skyAt(0.5));
  for (const c of noon) assert.ok(Math.abs(c - 1) < 0.08, `noon: ${noon.join(", ")}`);
  assert.ok(skyAt(0.3).sunDir[0] < 0, "morning: from the left");
  assert.ok(skyAt(0.7).sunDir[0] > 0, "afternoon: from the right");
  assert.ok(skyAt(0.5).sunDir[2] > skyAt(0.3).sunDir[2], "highest at noon");
});

test("night is dark and blue, lamps follow it; mist only in the early morning", () => {
  const midnight = skyAt(0);
  assert.equal(midnight.night, 1);
  assert.equal(skyAt(0.5).night, 0);
  const [r, , b] = flatLight(midnight);
  assert.ok(r < 0.45 && b > r, `midnight: ${flatLight(midnight).join(", ")}`);
  assert.ok(skyAt(0.29).mist.amount > 0.2);
  for (const tod of [0, 0.5, 0.8]) assert.equal(skyAt(tod).mist.amount, 0);
});

test("a pixel’s colour says roughly what it is: the farm’s soil, grass, pond, stone", () => {
  assert.equal(materialOf(219, 161, 90), "soil", "the dirt yard");
  assert.equal(materialOf(97, 104, 71), "leaves", "dark grass");
  assert.equal(materialOf(183, 166, 62), "leaves", "sunny grass");
  assert.equal(materialOf(76, 94, 75), "leaves", "a bush");
  assert.equal(materialOf(58, 119, 127), "water", "the pond");
  assert.equal(materialOf(82, 78, 72), "stone", "the well");
  assert.equal(materialOf(175, 96, 63), "other", "a red roof");
});
