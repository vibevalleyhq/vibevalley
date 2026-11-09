import { readFile } from "node:fs/promises";

import sharp from "sharp";

import { hash } from "./style-migration-inputs";

export async function comparePixels(before: string, after: string, diff?: string) {
  const [left, right] = await Promise.all([readFile(before), readFile(after)]);
  const [a, b] = await Promise.all([
    sharp(left).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(right).toColourspace("srgb").ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  const dimensionsEqual = a.info.width === b.info.width && a.info.height === b.info.height;
  let changedPixels = 0;
  const pixels = Buffer.alloc(a.data.length);
  if (dimensionsEqual)
    for (let offset = 0; offset < a.data.length; offset += 4) {
      const changed =
        a.data[offset] !== b.data[offset] ||
        a.data[offset + 1] !== b.data[offset + 1] ||
        a.data[offset + 2] !== b.data[offset + 2] ||
        a.data[offset + 3] !== b.data[offset + 3];
      if (changed) changedPixels++;
      pixels[offset] = changed ? 255 : Math.round((a.data.readUInt8(offset) + 255) / 2);
      pixels[offset + 1] = changed ? 0 : Math.round((a.data.readUInt8(offset + 1) + 255) / 2);
      pixels[offset + 2] = changed ? 0 : Math.round((a.data.readUInt8(offset + 2) + 255) / 2);
      pixels[offset + 3] = 255;
    }
  const diffPath = dimensionsEqual && changedPixels > 0 && diff !== undefined ? diff : null;
  if (diffPath !== null)
    await sharp(pixels, { raw: { width: a.info.width, height: a.info.height, channels: 4 } })
      .png()
      .toFile(diffPath);
  return {
    before: { path: before, hash: hash(left), width: a.info.width, height: a.info.height },
    after: { path: after, hash: hash(right), width: b.info.width, height: b.info.height },
    dimensionsEqual,
    changedPixels: dimensionsEqual ? changedPixels : null,
    diff: diffPath,
    passed: dimensionsEqual && changedPixels === 0,
  };
}
