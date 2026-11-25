import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vite-plus/test";

import { localUpdateFeedUrl, resolvePackageOptions } from "./build.ts";
import { buildFinderLayoutScript } from "./dmg-layout.ts";
import {
  channelBundleId,
  channelBundleName,
  channelFullIconFile,
  channelIconFile,
  compileAppIconCatalog,
  dmgBackgroundFile,
  packageArchitecture,
  requireDeveloperId,
  verifyMacExecutable,
} from "./package-platform.ts";
import { renderInfoPlist } from "./package.ts";

test("channel helpers resolve bundle names, bundle IDs, icons, and DMG background across all channels", () => {
  const root = resolve(import.meta.dirname, "../..");
  const cases: readonly {
    version: string;
    bundleName: string;
    bundleId: string;
    icns: string;
    fullIcon: string;
  }[] = [
    {
      version: "0.0.0",
      bundleName: "VibeValley-Dev",
      bundleId: "dev.vibevalley.app.dev",
      icns: "apps/mac/resources/icon-dev.icns",
      fullIcon: "apps/mac/resources/appicon-dev.png",
    },
    {
      version: "0.4.0-alpha.1",
      bundleName: "VibeValley-Alpha",
      bundleId: "dev.vibevalley.app.alpha",
      icns: "apps/mac/resources/icon-alpha.icns",
      fullIcon: "apps/mac/resources/appicon-alpha.png",
    },
    {
      version: "0.4.0-beta.2",
      bundleName: "VibeValley-Beta",
      bundleId: "dev.vibevalley.app.beta",
      icns: "apps/mac/resources/icon-beta.icns",
      fullIcon: "apps/mac/resources/appicon-beta.png",
    },
    {
      version: "0.4.0",
      bundleName: "VibeValley",
      bundleId: "dev.vibevalley.app",
      icns: "apps/mac/resources/icon.icns",
      fullIcon: "apps/mac/resources/appicon-release.png",
    },
  ];
  for (const item of cases) {
    expect(channelBundleName(item.version)).toBe(item.bundleName);
    expect(channelBundleId(item.version)).toBe(item.bundleId);
    expect(channelIconFile(item.version)).toBe(item.icns);
    expect(channelFullIconFile(item.version)).toBe(item.fullIcon);
    expect(existsSync(join(root, item.icns))).toBe(true);
    expect(existsSync(join(root, item.fullIcon))).toBe(true);
  }
  expect(dmgBackgroundFile).toBe("apps/mac/resources/dmg-background.png");
  expect(existsSync(join(root, dmgBackgroundFile))).toBe(true);
});

test("buildFinderLayoutScript targets channel bundle name and exact Retina window coordinates", () => {
  const script = buildFinderLayoutScript("VibeValley-Alpha 0.4.0-alpha.1", "VibeValley-Alpha.app");
  expect(script).toContain('tell disk "VibeValley-Alpha 0.4.0-alpha.1"');
  expect(script).toContain("set the bounds of container window to {120, 120, 800, 560}");
  expect(script).toContain("set icon size of viewOptions to 128");
  expect(script).toContain("set text size of viewOptions to 13");
  expect(script).toContain('set background picture of viewOptions to file ".background:background.png"');
  expect(script).toContain('set position of item "VibeValley-Alpha.app" of container window to {180, 210}');
  expect(script).toContain('set position of item "Applications" of container window to {500, 210}');

  const byMount = buildFinderLayoutScript("VibeValley-Alpha 0.4.0-alpha.1", "VibeValley-Alpha.app", "/Volumes/VibeValley-Alpha 0.4.0-alpha.1 1");
  expect(byMount).toContain('POSIX file "/Volumes/VibeValley-Alpha 0.4.0-alpha.1 1" as alias');
  expect(byMount).toContain("tell folder targetDisk");
});

test("regression: unknown package architectures and non-distribution signatures fail", () => {
  expect(() => packageArchitecture("ia32")).toThrow("architecture");
  expect(() => requireDeveloperId("Signature=adhoc\nTeamIdentifier=not set")).toThrow("Developer ID");
  expect(() => requireDeveloperId("Authority=Apple Development: Local\nTeamIdentifier=ABCDE12345")).toThrow("Developer ID");
  expect(() => requireDeveloperId("Authority=Developer ID Application: Local\nTeamIdentifier=ABCDE12345")).not.toThrow();
});

test.skipIf(process.platform !== "darwin")("regression: package checks inspect Mach-O slices and deployment targets", () => {
  const dir = mkdtempSync(join(tmpdir(), "vv-macho-"));
  const object = join(dir, "probe.o");
  const compile = (target: string) =>
    execFileSync("xcrun", ["clang", "-target", target, "-c", "-x", "c", "-", "-o", object], { input: "int main(void) { return 0; }" });
  try {
    compile("arm64-apple-macos14.0");
    expect(() => verifyMacExecutable(object, "arm64")).not.toThrow();
    expect(() => verifyMacExecutable(object, "x64")).toThrow("requires x86_64");
    compile("arm64-apple-macos14.1");
    expect(() => verifyMacExecutable(object, "arm64")).toThrow("requires macOS 14.1");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "darwin")("compileAppIconCatalog emits Assets.car from full-bleed channel PNG", () => {
  const root = resolve(import.meta.dirname, "../..");
  const dir = mkdtempSync(join(tmpdir(), "vv-car-"));
  const car = join(dir, "Assets.car");
  try {
    compileAppIconCatalog(join(root, channelFullIconFile("0.4.0-alpha.1")), car);
    expect(existsSync(car)).toBe(true);
    expect(statSync(car).size).toBeGreaterThan(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderInfoPlist embeds VibeValleyUpdateFeed only when non-empty and escapes XML", () => {
  const withFeed = renderInfoPlist({
    bundleId: "dev.vibevalley.app.alpha",
    bundleName: "VibeValley-Alpha",
    version: "0.1.0-alpha.2",
    updateFeed: "file:///Users/dev/a&b/dist/release.json",
  });
  expect(withFeed).toContain("<key>VibeValleyUpdateFeed</key><string>file:///Users/dev/a&amp;b/dist/release.json</string>");

  const withoutFeed = renderInfoPlist({
    bundleId: "dev.vibevalley.app.beta",
    bundleName: "VibeValley-Beta",
    version: "0.1.0-beta.1",
  });
  expect(withoutFeed).not.toContain("VibeValleyUpdateFeed");
});

test("alpha builds default to zip + local file:// update feed while beta and release never pass a local feed", () => {
  const outDir = "/Users/dev/My Apps/dist";
  const alpha = resolvePackageOptions({
    channel: "alpha",
    targetVersion: "0.1.0-alpha.2",
    outDir,
    noDmg: false,
    noZip: false,
    noLocalFeed: false,
    verify: false,
    skipVerify: false,
    skipBuild: false,
  });
  expect(alpha.makeZip).toBe(true);
  expect(alpha.localFeed).toBe(localUpdateFeedUrl(outDir));
  expect(alpha.localFeed).toBe("file:///Users/dev/My%20Apps/dist/release.json");
  expect(alpha.packageArgs).toContain("--update-feed");
  expect(alpha.packageArgs).toContain("file:///Users/dev/My%20Apps/dist/release.json");

  const alphaNoFeed = resolvePackageOptions({
    channel: "alpha",
    targetVersion: "0.1.0-alpha.2",
    outDir,
    noDmg: false,
    noZip: false,
    noLocalFeed: true,
    verify: false,
    skipVerify: false,
    skipBuild: false,
  });
  expect(alphaNoFeed.localFeed).toBeUndefined();
  expect(alphaNoFeed.packageArgs).not.toContain("--update-feed");

  for (const [channel, targetVersion] of [
    ["beta", "0.1.0-beta.1"],
    ["release", "0.1.0"],
  ] as const) {
    const plan = resolvePackageOptions({
      channel,
      targetVersion,
      outDir,
      noDmg: false,
      noZip: false,
      noLocalFeed: false,
      verify: false,
      skipVerify: false,
      skipBuild: false,
    });
    expect(plan.makeZip).toBe(true);
    expect(plan.localFeed).toBeUndefined();
    expect(plan.packageArgs).not.toContain("--update-feed");
  }
});
