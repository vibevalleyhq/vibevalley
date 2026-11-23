import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { newer } from "./releases.ts";

export const minimumMacOS = "14.0";

export const dmgBackgroundFile = "apps/mac/resources/dmg-background.png";

type ReleaseChannel = "dev" | "alpha" | "beta" | "release";

function releaseChannel(version: string): ReleaseChannel {
  if (version === "0.0.0") return "dev";
  if (version.includes("-alpha.")) return "alpha";
  if (version.includes("-beta.")) return "beta";
  return "release";
}

export function channelBundleName(version: string): string {
  switch (releaseChannel(version)) {
    case "dev":
      return "VibeValley-Dev";
    case "alpha":
      return "VibeValley-Alpha";
    case "beta":
      return "VibeValley-Beta";
    case "release":
      return "VibeValley";
  }
}

export function channelBundleId(version: string): string {
  switch (releaseChannel(version)) {
    case "dev":
      return "dev.vibevalley.app.dev";
    case "alpha":
      return "dev.vibevalley.app.alpha";
    case "beta":
      return "dev.vibevalley.app.beta";
    case "release":
      return "dev.vibevalley.app";
  }
}

export function channelIconFile(version: string): string {
  switch (releaseChannel(version)) {
    case "dev":
      return "apps/mac/resources/icon-dev.icns";
    case "alpha":
      return "apps/mac/resources/icon-alpha.icns";
    case "beta":
      return "apps/mac/resources/icon-beta.icns";
    case "release":
      return "apps/mac/resources/icon.icns";
  }
}

export function channelFullIconFile(version: string): string {
  switch (releaseChannel(version)) {
    case "dev":
      return "apps/mac/resources/appicon-dev.png";
    case "alpha":
      return "apps/mac/resources/appicon-alpha.png";
    case "beta":
      return "apps/mac/resources/appicon-beta.png";
    case "release":
      return "apps/mac/resources/appicon-release.png";
  }
}

const appIconSlots: readonly { size: string; scale: string; pixels: number; filename: string }[] = [
  { size: "16x16", scale: "1x", pixels: 16, filename: "icon_16x16.png" },
  { size: "16x16", scale: "2x", pixels: 32, filename: "icon_16x16@2x.png" },
  { size: "32x32", scale: "1x", pixels: 32, filename: "icon_32x32.png" },
  { size: "32x32", scale: "2x", pixels: 64, filename: "icon_32x32@2x.png" },
  { size: "128x128", scale: "1x", pixels: 128, filename: "icon_128x128.png" },
  { size: "128x128", scale: "2x", pixels: 256, filename: "icon_128x128@2x.png" },
  { size: "256x256", scale: "1x", pixels: 256, filename: "icon_256x256.png" },
  { size: "256x256", scale: "2x", pixels: 512, filename: "icon_256x256@2x.png" },
  { size: "512x512", scale: "1x", pixels: 512, filename: "icon_512x512.png" },
  { size: "512x512", scale: "2x", pixels: 1024, filename: "icon_512x512@2x.png" },
];

export function compileAppIconCatalog(sourcePng: string, destinationAssetsCar: string): void {
  const work = mkdtempSync(join(tmpdir(), "vv-actool-"));
  const xcassets = join(work, "Assets.xcassets");
  const appiconset = join(xcassets, "AppIcon.appiconset");
  const compiled = join(work, "compiled");
  try {
    mkdirSync(appiconset, { recursive: true });
    mkdirSync(compiled, { recursive: true });
    writeFileSync(join(xcassets, "Contents.json"), JSON.stringify({ info: { author: "xcode", version: 1 } }, null, 2));
    for (const slot of appIconSlots) {
      execFileSync("sips", ["-z", String(slot.pixels), String(slot.pixels), sourcePng, "--out", join(appiconset, slot.filename)], {
        stdio: ["ignore", "ignore", "pipe"],
      });
    }
    writeFileSync(
      join(appiconset, "Contents.json"),
      JSON.stringify(
        {
          images: appIconSlots.map((slot) => ({
            filename: slot.filename,
            idiom: "mac",
            scale: slot.scale,
            size: slot.size,
          })),
          info: { author: "xcode", version: 1 },
        },
        null,
        2,
      ),
    );
    execFileSync(
      "xcrun",
      [
        "actool",
        xcassets,
        "--compile",
        compiled,
        "--platform",
        "macosx",
        "--minimum-deployment-target",
        minimumMacOS,
        "--app-icon",
        "AppIcon",
        "--output-partial-info-plist",
        join(work, "partial-info.plist"),
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const builtCar = join(compiled, "Assets.car");
    if (!existsSync(builtCar)) {
      throw new Error(`xcrun actool did not emit Assets.car from ${sourcePng}`);
    }
    cpSync(builtCar, destinationAssetsCar);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const version = (v: string) => (v + ".0.0").split(".").slice(0, 3).join(".");

const machArch = { arm64: "arm64", x64: "x86_64" };

export function packageArchitecture(nodeArch: string): keyof typeof machArch {
  if (nodeArch === "arm64" || nodeArch === "x64") return nodeArch;
  throw new Error(`Unsupported macOS package architecture: ${nodeArch}`);
}

export function verifyMacExecutable(file: string, arch: keyof typeof machArch) {
  const slice = machArch[arch];
  const slices = execFileSync("xcrun", ["lipo", "-archs", file], { encoding: "utf8" }).trim().split(/\s+/u);
  if (!slices.includes(slice)) throw new Error(`${file} has ${slices.join(", ")} but the package requires ${slice}`);
  const commands = execFileSync("xcrun", ["vtool", "-arch", slice, "-show-build", file], { encoding: "utf8" });
  const minimum = /^\s*minos\s+(\d+(?:\.\d+){0,2})$/mu.exec(commands)?.[1];
  if (!/^\s*platform\s+MACOS$/mu.test(commands) || !minimum) throw new Error(`No macOS deployment target found for ${file} (${slice})`);
  if (newer(version(minimum), version(minimumMacOS))) {
    throw new Error(`${file} requires macOS ${minimum} but the bundle declares ${minimumMacOS}`);
  }
}

export function requireDeveloperId(details: string) {
  if (!/^Authority=Developer ID Application:.+$/mu.test(details) || !/^TeamIdentifier=[A-Z0-9]+$/mu.test(details)) {
    throw new Error("Release signing requires a Developer ID Application identity and TeamIdentifier");
  }
}
