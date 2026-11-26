import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { expect, test } from "vite-plus/test";

import { shouldPackageAsset } from "./package-assets.ts";

test("shouldPackageAsset excludes website-only site assets and keeps app assets", () => {
  const excluded = [
    "site",
    "site/hero-day.webp",
    "site/hero-morning.webp",
    "site/hero-evening.webp",
    "site/hero-night.webp",
    "site/postcard.png",
    "site/tiles/b_notice_pavilion.webp",
    "site\\tiles\\crop_wheat.webp",
  ];
  for (const path of excluded) {
    expect(shouldPackageAsset(path), `expected excluded: ${path}`).toBe(false);
  }

  const included = [
    "",
    "brand/opening-day.webp",
    "brand/tray-release.png",
    "icons/app-256.png",
    "avatars/avatar-orchestrator.png",
    "avatars/rail/manager-default-2x.png",
    "engines/claude.png",
    "engines/vibevalley.png",
    "diorama/manifest.json",
    "diorama/meshes.bin",
    "diorama/print/materials.vvtex",
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
    mkdirSync(join(srcRoot, "site/tiles"), { recursive: true });
    mkdirSync(join(srcRoot, "brand"), { recursive: true });
    mkdirSync(join(srcRoot, "icons"), { recursive: true });
    mkdirSync(join(srcRoot, "avatars/rail"), { recursive: true });
    mkdirSync(join(srcRoot, "engines"), { recursive: true });
    mkdirSync(join(srcRoot, "diorama"), { recursive: true });
    writeFileSync(join(srcRoot, "site/hero-day.webp"), "site-only");
    writeFileSync(join(srcRoot, "site/tiles/b_notice_pavilion.webp"), "site-only");
    writeFileSync(join(srcRoot, "brand/opening-day.webp"), "app");
    writeFileSync(join(srcRoot, "icons/app-256.png"), "app");
    writeFileSync(join(srcRoot, "avatars/rail/manager-default-2x.png"), "app");
    writeFileSync(join(srcRoot, "engines/claude.png"), "app");
    writeFileSync(join(srcRoot, "diorama/manifest.json"), "app");

    cpSync(srcRoot, dstRoot, {
      recursive: true,
      dereference: true,
      filter: (src) => shouldPackageAsset(relative(srcRoot, src)),
    });

    expect(existsSync(join(dstRoot, "site"))).toBe(false);
    expect(existsSync(join(dstRoot, "site/hero-day.webp"))).toBe(false);
    expect(existsSync(join(dstRoot, "brand/opening-day.webp"))).toBe(true);
    expect(existsSync(join(dstRoot, "icons/app-256.png"))).toBe(true);
    expect(existsSync(join(dstRoot, "avatars/rail/manager-default-2x.png"))).toBe(true);
    expect(existsSync(join(dstRoot, "engines/claude.png"))).toBe(true);
    expect(existsSync(join(dstRoot, "diorama/manifest.json"))).toBe(true);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
