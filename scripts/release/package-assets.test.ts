import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { expect, test } from "vite-plus/test";

import { shouldPackageAsset } from "./package-assets.ts";

test("shouldPackageAsset excludes website-only title assets and keeps app assets", () => {
  const excluded = [
    "title",
    "title/fern.png",
    "title/sprites.json",
    "title\\cloud-big-1.png",
    "pixel/title-day.jpg",
    "pixel/title-morning.jpg",
    "pixel/title-evening.jpg",
    "pixel/title-night.jpg",
  ];
  for (const path of excluded) {
    expect(shouldPackageAsset(path), `expected excluded: ${path}`).toBe(false);
  }

  const included = [
    "",
    "brand/opening-day.webp",
    "fonts/fusion-pixel-12px-proportional-zh_hans.otf",
    "cursors/hand.png",
    "icons/app-256.png",
    "pixel/map.png",
    "pixel/banner-title.png",
    "village.ldtk",
  ];
  for (const path of included) {
    expect(shouldPackageAsset(path), `expected included: ${path}`).toBe(true);
  }
});

test("cpSync with shouldPackageAsset omits excluded website assets from copied tree", () => {
  const work = mkdtempSync(join(tmpdir(), "vv-pkg-assets-"));
  const srcRoot = join(work, "assets");
  const dstRoot = join(work, "out");
  try {
    mkdirSync(join(srcRoot, "title"), { recursive: true });
    mkdirSync(join(srcRoot, "pixel"), { recursive: true });
    mkdirSync(join(srcRoot, "brand"), { recursive: true });
    mkdirSync(join(srcRoot, "fonts"), { recursive: true });
    writeFileSync(join(srcRoot, "title/fern.png"), "site-only");
    writeFileSync(join(srcRoot, "pixel/title-day.jpg"), "site-only");
    writeFileSync(join(srcRoot, "pixel/map.png"), "app");
    writeFileSync(join(srcRoot, "brand/opening-day.webp"), "app");
    writeFileSync(join(srcRoot, "fonts/fusion-pixel-12px-proportional-zh_hans.otf"), "app");
    writeFileSync(join(srcRoot, "village.ldtk"), "app");

    cpSync(srcRoot, dstRoot, {
      recursive: true,
      dereference: true,
      filter: (src) => shouldPackageAsset(relative(srcRoot, src)),
    });

    expect(existsSync(join(dstRoot, "title"))).toBe(false);
    expect(existsSync(join(dstRoot, "pixel/title-day.jpg"))).toBe(false);
    expect(existsSync(join(dstRoot, "pixel/map.png"))).toBe(true);
    expect(existsSync(join(dstRoot, "brand/opening-day.webp"))).toBe(true);
    expect(existsSync(join(dstRoot, "fonts/fusion-pixel-12px-proportional-zh_hans.otf"))).toBe(true);
    expect(existsSync(join(dstRoot, "village.ldtk"))).toBe(true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
