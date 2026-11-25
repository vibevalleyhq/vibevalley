import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { newer } from "./releases.ts";
import { bumpVersion, channelOfVersion, formatVersion, normalizeChannel, parseVersion, readRootVersion, writeRootVersion } from "./version.ts";

test("parseVersion, formatVersion, normalizeChannel, and channelOfVersion handle 3-digit channel versions", () => {
  expect(normalizeChannel("alpha")).toBe("alpha");
  expect(normalizeChannel("beta")).toBe("beta");
  expect(normalizeChannel("release")).toBe("release");
  expect(normalizeChannel("final")).toBe("release");
  expect(normalizeChannel("dev")).toBeUndefined();

  expect(parseVersion("0.1.0-alpha.1")).toEqual({
    major: 0,
    minor: 1,
    patch: 0,
    pre: { stage: "alpha", n: 1 },
  });
  expect(formatVersion(parseVersion("1.2.3-beta.4")!)).toBe("1.2.3-beta.4");
  expect(parseVersion("0.1.0-gamma.1")).toBeUndefined();
  expect(parseVersion("0.1")).toBeUndefined();

  expect(channelOfVersion("0.0.0")).toBe("dev");
  expect(channelOfVersion("0.1.0-alpha.1")).toBe("alpha");
  expect(channelOfVersion("0.1.0-beta.2")).toBe("beta");
  expect(channelOfVersion("0.1.0")).toBe("release");
});

test("bumpVersion advances monotonically across auto, patch, minor, and major transitions", () => {
  const cases: readonly [string, "alpha" | "beta" | "release", "auto" | "patch" | "minor" | "major", string][] = [
    ["0.0.0", "alpha", "auto", "0.1.0-alpha.1"],
    ["0.0.0", "beta", "auto", "0.1.0-beta.1"],
    ["0.0.0", "release", "auto", "0.1.0"],
    ["0.1.0-alpha.1", "alpha", "auto", "0.1.0-alpha.2"],
    ["0.1.0-alpha.1", "beta", "auto", "0.1.0-beta.1"],
    ["0.1.0-alpha.1", "release", "auto", "0.1.0"],
    ["0.1.0-beta.2", "alpha", "auto", "0.1.1-alpha.1"],
    ["0.1.0-beta.2", "beta", "auto", "0.1.0-beta.3"],
    ["0.1.0-beta.2", "release", "auto", "0.1.0"],
    ["0.1.0", "alpha", "auto", "0.1.1-alpha.1"],
    ["0.1.0", "beta", "auto", "0.1.1-beta.1"],
    ["0.1.0", "release", "auto", "0.1.1"],
    ["0.1.2-alpha.3", "alpha", "patch", "0.1.3-alpha.1"],
    ["0.1.2-alpha.3", "alpha", "minor", "0.2.0-alpha.1"],
    ["0.1.2-beta.1", "release", "major", "1.0.0"],
  ];

  for (const [current, channel, increment, expected] of cases) {
    const next = bumpVersion(current, channel, increment);
    expect(next).toBe(expected);
    expect(newer(next, current)).toBe(true);
  }
});

test("readRootVersion and writeRootVersion update package.json preserving layout", () => {
  const dir = mkdtempSync(join(tmpdir(), "vv-version-test-"));
  try {
    writeFileSync(join(dir, "package.json"), `${JSON.stringify({ name: "vibevalley", private: true, type: "module" }, null, 2)}\n`);
    expect(readRootVersion(dir)).toBeUndefined();

    writeRootVersion(dir, "0.1.0-alpha.1");
    expect(readRootVersion(dir)).toBe("0.1.0-alpha.1");
    const keysAfterInsert = Object.keys(JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as Record<string, unknown>);
    expect(keysAfterInsert.slice(0, 2)).toEqual(["name", "version"]);

    writeRootVersion(dir, "0.1.0-beta.1");
    expect(readRootVersion(dir)).toBe("0.1.0-beta.1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
