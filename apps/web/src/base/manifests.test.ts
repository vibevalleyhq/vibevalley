import { readFileSync } from "node:fs";

import { Schema } from "effect";
import { expect, test } from "vite-plus/test";

import { CursorManifest, SpriteManifest, TitleManifest } from "./manifests";

test("shipped manifests decode at the same boundary used by the page", () => {
  expect(
    Object.keys(Schema.decodeSync(Schema.fromJsonString(SpriteManifest))(readFileSync(new URL("../../public/pixel/sprites.json", import.meta.url), "utf8")))
      .length,
  ).toBeGreaterThan(0);
  expect(
    Object.keys(Schema.decodeSync(Schema.fromJsonString(CursorManifest))(readFileSync(new URL("../../public/cursors/cursors.json", import.meta.url), "utf8")))
      .length,
  ).toBeGreaterThan(0);
  expect(
    Object.keys(Schema.decodeSync(Schema.fromJsonString(TitleManifest))(readFileSync(new URL("../../public/title/sprites.json", import.meta.url), "utf8")))
      .length,
  ).toBeGreaterThan(0);
});

test("manifest decoding rejects missing anchors and non-finite coordinates", () => {
  expect(() => Schema.decodeUnknownSync(SpriteManifest)({ map: { w: 384, h: 256 } })).toThrow();
  expect(() => Schema.decodeSync(CursorManifest)({ hand: { hx: Infinity, hy: 0 } })).toThrow();
});
