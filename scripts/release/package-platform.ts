import { execFileSync } from "node:child_process";

import { newer } from "./releases.ts";

export const minimumMacOS = "14.0";

export function channelIconFile(version: string): string {
  if (version === "0.0.0") return "apps/mac/resources/icon-dev.icns";
  if (version.includes("-alpha.")) return "apps/mac/resources/icon-alpha.icns";
  if (version.includes("-beta.")) return "apps/mac/resources/icon-beta.icns";
  return "apps/mac/resources/icon.icns";
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
