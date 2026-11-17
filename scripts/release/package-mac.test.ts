import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  assembleAppBundle,
  buildArtifactEntry,
  bundleIdentifierForChannel,
  channelForVersion,
  computeSchemaHash,
  createReleaseManifest,
  renderInfoPlist,
  resolveReleaseVersion,
} from "./package-mac.ts";

const repoRoot = resolve(import.meta.dirname, "../..");

describe("package-mac helpers", () => {
  it("resolves release versions and bundle identifiers across channels", () => {
    expect(resolveReleaseVersion("v1.4.2", "v0.1.0")).toBe("1.4.2");
    expect(resolveReleaseVersion("1.4.2-beta.3")).toBe("1.4.2-beta.3");
    expect(resolveReleaseVersion("", "v0.9.0-alpha.1")).toBe("0.9.0-alpha.1");
    expect(resolveReleaseVersion("deadbeef", "abc1234")).toBe("0.0.0");

    expect(channelForVersion("1.4.2")).toBe("stable");
    expect(channelForVersion("1.4.2-beta.3")).toBe("beta");
    expect(channelForVersion("1.4.2-alpha.1")).toBe("alpha");
    expect(channelForVersion("0.0.0")).toBe("dev");

    expect(bundleIdentifierForChannel("stable")).toBe("dev.vibevalley.app");
    expect(bundleIdentifierForChannel("beta")).toBe("dev.vibevalley.app.beta");
    expect(bundleIdentifierForChannel("alpha")).toBe("dev.vibevalley.app.alpha");
    expect(bundleIdentifierForChannel("dev")).toBe("dev.vibevalley.app.dev");
  });

  it("renders valid macOS Info.plist metadata", () => {
    const plist = renderInfoPlist("0.4.0-beta.2");
    expect(plist).toContain("<key>CFBundleExecutable</key>\n  <string>vibe-desktop</string>");
    expect(plist).toContain("<key>CFBundleIconFile</key>\n  <string>icon.icns</string>");
    expect(plist).toContain("<key>CFBundleIdentifier</key>\n  <string>dev.vibevalley.app.beta</string>");
    expect(plist).toContain("<key>CFBundleShortVersionString</key>\n  <string>0.4.0-beta.2</string>");
    expect(plist).toContain("<key>CFBundleVersion</key>\n  <string>0.4.0-beta.2</string>");
    expect(plist).toContain("<key>NSCameraUsageDescription</key>");
    expect(plist).toContain("<key>NSMicrophoneUsageDescription</key>");
  });

  it("computes deterministic schema SHA-256 over sorted internal migration up scripts", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vv-pack-schema-"));
    try {
      const m1 = join(tmp, "internal", "domain", "issue", "migrations");
      const m2 = join(tmp, "internal", "vault", "migrations");
      mkdirSync(m1, { recursive: true });
      mkdirSync(m2, { recursive: true });
      writeFileSync(join(m1, "0001_init.up.sql"), "CREATE TABLE issue (id TEXT PRIMARY KEY);\n");
      writeFileSync(join(m1, "0001_init.down.sql"), "DROP TABLE issue;\n");
      writeFileSync(join(m2, "0001_init.up.sql"), "CREATE TABLE vault_secret (id TEXT PRIMARY KEY);\n");

      const h1 = computeSchemaHash(tmp);
      const h2 = computeSchemaHash(tmp);
      expect(h1).toMatch(/^[0-9a-f]{64}$/u);
      expect(h1).toBe(h2);

      // Down migrations do not change schema baseline hash; up migrations do.
      writeFileSync(join(m1, "0001_init.down.sql"), "DROP TABLE IF EXISTS issue;\n");
      expect(computeSchemaHash(tmp)).toBe(h1);

      writeFileSync(join(m2, "0001_init.up.sql"), "CREATE TABLE vault_secret (id TEXT PRIMARY KEY, kind TEXT);\n");
      expect(computeSchemaHash(tmp)).not.toBe(h1);

      // Real repository migration hash matches deterministic SHA-256 format.
      expect(computeSchemaHash(repoRoot)).toMatch(/^[0-9a-f]{64}$/u);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("assembles VibeValley.app bundle layout and release.json manifest without compiling", () => {
    const tmp = mkdtempSync(join(tmpdir(), "vv-pack-layout-"));
    try {
      const srcDir = join(tmp, "src");
      const webDist = join(srcDir, "web-dist");
      const outDir = join(tmp, "dist");
      mkdirSync(join(webDist, "assets"), { recursive: true });
      writeFileSync(join(webDist, "index.html"), "<!doctype html><html><body>Web</body></html>");
      writeFileSync(join(webDist, "assets", "app.js"), "console.log('ok');");

      const desktopBin = join(srcDir, "vibe-desktop");
      const cliBin = join(srcDir, "vibe");
      const iconFile = join(srcDir, "icon.icns");
      writeFileSync(desktopBin, "#!/bin/sh\necho desktop\n");
      writeFileSync(cliBin, "#!/bin/sh\necho cli\n");
      writeFileSync(iconFile, "icns-placeholder");

      const assembled = assembleAppBundle({
        outDir,
        version: "0.5.0",
        desktopBinary: desktopBin,
        cliBinary: cliBin,
        iconPath: iconFile,
        webDistDir: webDist,
      });

      expect(existsSync(assembled.infoPlistPath)).toBe(true);
      expect(readFileSync(assembled.infoPlistPath, "utf8")).toContain("<string>dev.vibevalley.app</string>");
      expect(readFileSync(join(assembled.appPath, "Contents", "Resources", "icon.icns"), "utf8")).toBe("icns-placeholder");
      expect(readFileSync(join(assembled.webDir, "index.html"), "utf8")).toContain("Web");
      expect(readFileSync(join(assembled.webDir, "assets", "app.js"), "utf8")).toContain("console.log");
      expect(statSync(assembled.executablePath).mode & 0o111).toBeGreaterThan(0);
      expect(statSync(assembled.cliPath).mode & 0o111).toBeGreaterThan(0);
      expect(existsSync(assembled.distDesktopBinary)).toBe(true);

      const zipStub = join(outDir, "VibeValley-0.5.0-arm64.zip");
      writeFileSync(zipStub, "fake-zip-bytes");
      const entry = buildArtifactEntry(zipStub, "arm64");
      const expectedSha = createHash("sha512").update("fake-zip-bytes").digest("hex");
      expect(entry).toEqual({
        arch: "arm64",
        file: "VibeValley-0.5.0-arm64.zip",
        size: 14,
        sha512: expectedSha,
      });

      const manifest = createReleaseManifest({
        version: "0.5.0",
        notes: ["feat: native desktop bundle"],
        schema: "a".repeat(64),
        builds: [entry],
      });
      expect(manifest).toEqual({
        version: "0.5.0",
        notes: ["feat: native desktop bundle"],
        schema: "a".repeat(64),
        page: "https://github.com/vibevalleyhq/vibevalley/releases/tag/v0.5.0",
        builds: [entry],
      });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
