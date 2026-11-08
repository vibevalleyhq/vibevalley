import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import sharp from "sharp";
import { expect, onTestFinished, test } from "vite-plus/test";

import { comparePixels } from "./style-migration-pixels";

async function images() {
  const directory = await mkdtemp(join(tmpdir(), "migration-pixels-"));
  onTestFinished(() => rm(directory, { recursive: true, force: true }));
  return { before: join(directory, "before.png"), after: join(directory, "after.png"), diff: join(directory, "diff.png") };
}

test("pixel equality does not depend on PNG compression", async () => {
  const paths = await images();
  const image = sharp({ create: { width: 20, height: 20, channels: 4, background: "white" } });
  await image.clone().png({ compressionLevel: 0 }).toFile(paths.before);
  await image.clone().png({ compressionLevel: 9 }).toFile(paths.after);
  const result = await comparePixels(paths.before, paths.after, paths.diff);
  expect(result.changedPixels).toBe(0);
  expect(result.passed).toBe(true);
  expect(result.before.hash).not.toBe(result.after.hash);
  expect(result.diff).toBeNull();
});

test.each([0, 1, 2, 3])("a one-channel difference has no tolerance: channel %s", async (channel) => {
  const paths = await images();
  const before = Buffer.from([128, 128, 128, 255, 128, 128, 128, 255]);
  const after = Buffer.from(before);
  after[channel] = before.readUInt8(channel) - 1;
  await sharp(before, { raw: { width: 2, height: 1, channels: 4 } })
    .png()
    .toFile(paths.before);
  await sharp(after, { raw: { width: 2, height: 1, channels: 4 } })
    .png()
    .toFile(paths.after);
  const result = await comparePixels(paths.before, paths.after, paths.diff);
  expect(result.changedPixels).toBe(1);
  expect(result.passed).toBe(false);
  expect(result.diff).toBe(paths.diff);
});

test("different dimensions fail rather than comparing a common crop", async () => {
  const paths = await images();
  await sharp({ create: { width: 2, height: 1, channels: 4, background: "white" } })
    .png()
    .toFile(paths.before);
  await sharp({ create: { width: 1, height: 2, channels: 4, background: "white" } })
    .png()
    .toFile(paths.after);
  const result = await comparePixels(paths.before, paths.after, paths.diff);
  expect(result.passed).toBe(false);
  expect(result.dimensionsEqual).toBe(false);
  expect(result.changedPixels).toBeNull();
});

test("missing images are errors, not an empty passing comparison", async () => {
  const paths = await images();
  await expect(comparePixels(paths.before, paths.after)).rejects.toThrow();
});
