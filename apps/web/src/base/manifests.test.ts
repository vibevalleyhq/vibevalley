import { readFileSync } from "node:fs";

import { expect, test } from "vite-plus/test";

import { jsonString } from "@vibevalley/protocol/schema";

import { CursorManifest, SpriteManifest } from "./manifests";

test("shipped manifests decode at the same boundary used by the page", () => {
  expect(
    Object.keys(jsonString(SpriteManifest).parse(readFileSync(new URL("../../public/pixel/sprites.json", import.meta.url), "utf8"))).length,
  ).toBeGreaterThan(0);
  expect(
    Object.keys(jsonString(CursorManifest).parse(readFileSync(new URL("../../public/cursors/cursors.json", import.meta.url), "utf8"))).length,
  ).toBeGreaterThan(0);
});

test("manifest decoding rejects missing anchors and non-finite coordinates", () => {
  expect(() => SpriteManifest.parse({ map: { w: 384, h: 256 } })).toThrow();
  expect(() => CursorManifest.parse({ hand: { hx: Infinity, hy: 0 } })).toThrow();
});
