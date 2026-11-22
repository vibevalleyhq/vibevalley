import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vite-plus/test";

import { channelIconFile, packageArchitecture, requireDeveloperId, verifyMacExecutable } from "./package-platform.ts";

test("channelIconFile selects matching channel icns assets", () => {
  const root = resolve(import.meta.dirname, "../..");
  const cases: readonly (readonly [string, string])[] = [
    ["0.0.0", "apps/mac/resources/icon-dev.icns"],
    ["0.4.0-alpha.1", "apps/mac/resources/icon-alpha.icns"],
    ["0.4.0-beta.2", "apps/mac/resources/icon-beta.icns"],
    ["0.4.0", "apps/mac/resources/icon.icns"],
  ];
  for (const [version, expected] of cases) {
    const file = channelIconFile(version);
    expect(file).toBe(expected);
    expect(existsSync(join(root, file))).toBe(true);
  }
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
