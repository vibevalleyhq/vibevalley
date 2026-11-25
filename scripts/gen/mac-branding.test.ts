import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32, deflateSync } from "node:zlib";

import { describe, expect, it } from "vite-plus/test";

import { generateMacBranding } from "./mac-branding.ts";

function pngChunk(kind: string, data: Uint8Array): Buffer {
  const type = Buffer.from(kind, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([type, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(crcInput) >>> 0, 0);
  return Buffer.concat([len, type, data, crc]);
}

function makeSolidPng(width: number, height: number, r: number, g: number, b: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const rowSize = 1 + width * 3;
  const raw = Buffer.alloc(rowSize * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * rowSize;
    raw[rowStart] = 0;
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 3;
      raw[px] = r;
      raw[px + 1] = g;
      raw[px + 2] = b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

describe("mac-branding", () => {
  it("returns 1 when required raw inputs are missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "vv-branding-missing-"));
    try {
      expect(generateMacBranding(join(dir, "raw"), join(dir, "out"))).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  if (process.platform === "darwin") {
    it("generates all channel icons, icns bundles, and 144 DPI dmg background", () => {
      const dir = mkdtempSync(join(tmpdir(), "vv-branding-test-"));
      try {
        const rawDir = join(dir, "raw");
        const outDir = join(dir, "out");
        const iconsDir = join(dir, "icons");
        mkdirSync(rawDir, { recursive: true });
        writeFileSync(join(rawDir, "app-icon.png"), makeSolidPng(64, 64, 120, 180, 90));

        expect(generateMacBranding(rawDir, outDir, false, iconsDir)).toBe(0);

        for (const name of ["appicon-release.png", "appicon-alpha.png", "appicon-beta.png", "appicon-dev.png"]) {
          const path = join(outDir, name);
          expect(existsSync(path)).toBe(true);
          const info = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", path], { encoding: "utf8" });
          expect(info).toContain("pixelWidth: 1024");
          expect(info).toContain("pixelHeight: 1024");
        }

        for (const icns of ["icon.icns", "icon-alpha.icns", "icon-beta.icns", "icon-dev.icns"]) {
          const path = join(outDir, icns);
          expect(existsSync(path)).toBe(true);
          expect(readFileSync(path).subarray(0, 4).toString("ascii")).toBe("icns");
        }

        for (const dim of [32, 64, 256]) {
          const iconPath = join(iconsDir, `app-${dim}.png`);
          expect(existsSync(iconPath)).toBe(true);
          const iconInfo = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", iconPath], { encoding: "utf8" });
          expect(iconInfo).toContain(`pixelWidth: ${dim}`);
          expect(iconInfo).toContain(`pixelHeight: ${dim}`);
        }

        const dmg = join(outDir, "dmg-background.png");
        expect(existsSync(dmg)).toBe(true);
        const dmgInfo = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", "-g", "dpiWidth", dmg], { encoding: "utf8" });
        expect(dmgInfo).toContain("pixelWidth: 1360");
        expect(dmgInfo).toContain("pixelHeight: 880");
        expect(dmgInfo).toContain("dpiWidth: 144");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }, 30_000);
  }
});
