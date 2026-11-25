import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { flattenPaperTheme, generateTokenTargets, parseDesignTokens, renderNshJson, runTokensGen } from "./tokens.ts";

const root = resolve(import.meta.dirname, "../..");

describe("design/tokens.json generator", () => {
  const tokens = parseDesignTokens(readFileSync(resolve(root, "design/tokens.json"), "utf8"));

  it("emits clean Papertrails and workbench theme keys without legacy pixel or catalog tokens", () => {
    const theme = flattenPaperTheme(tokens);
    expect(Object.keys(theme)).toHaveLength(33);
    expect(theme.white).toBe("#fff");
    expect(theme["cream-50"]).toBe("#f7e8c4");
    expect(theme["avatar-leaf"]).toBe("#dcebc8");
    expect(theme["avatar-sky"]).toBe("#cfe6f5");
    expect(theme["lcd-ink"]).toBe("#22341a");
    for (const key of Object.keys(theme)) {
      expect(key.startsWith("px-")).toBe(false);
      expect(key.startsWith("catalog-")).toBe(false);
    }
  });

  it("preserves nsh.json non-tailwind metadata and strips legacy pixel font and shadow tokens", () => {
    const currentNsh = readFileSync(resolve(root, "apps/mac/ui/nsh.json"), "utf8");
    const parsedCurrent = JSON.parse(currentNsh) as Record<string, unknown>;
    const rendered = JSON.parse(renderNshJson(tokens, currentNsh)) as {
      name: unknown;
      id: unknown;
      version: unknown;
      build: unknown;
      capabilities: unknown;
      theme: unknown;
      tailwind: { fontFamily: Record<string, string>; shadow: Record<string, string> };
    };

    expect(rendered.name).toBe(parsedCurrent.name);
    expect(rendered.id).toBe(parsedCurrent.id);
    expect(rendered.version).toBe(parsedCurrent.version);
    expect(rendered.build).toBe(parsedCurrent.build);
    expect(rendered.capabilities).toEqual(parsedCurrent.capabilities);
    expect(rendered.theme).toBe(parsedCurrent.theme);
    expect(rendered.tailwind.fontFamily).toEqual({ sans: "PingFang SC", mono: "Menlo" });
    expect("px" in rendered.tailwind.shadow).toBe(false);
  });

  it("syncs apps/mobile/design/theme.json and apps/mobile/nsh.json while preserving mobile fields", () => {
    const tempDir = mkdtempSync(join(tmpdir(), "vv-tokens-mobile-"));
    try {
      mkdirSync(join(tempDir, "design"), { recursive: true });
      mkdirSync(join(tempDir, "apps/mac/ui/design"), { recursive: true });
      mkdirSync(join(tempDir, "apps/mac/src"), { recursive: true });
      mkdirSync(join(tempDir, "apps/site/src/ui"), { recursive: true });
      mkdirSync(join(tempDir, "apps/mobile"), { recursive: true });

      writeFileSync(join(tempDir, "design/tokens.json"), readFileSync(resolve(root, "design/tokens.json"), "utf8"), "utf8");
      writeFileSync(join(tempDir, "apps/mac/ui/nsh.json"), readFileSync(resolve(root, "apps/mac/ui/nsh.json"), "utf8"), "utf8");
      writeFileSync(join(tempDir, "apps/site/src/ui/global.css"), readFileSync(resolve(root, "apps/site/src/ui/global.css"), "utf8"), "utf8");

      const mobileManifest = {
        name: "VibeValley",
        id: "dev.vibevalley.mobile",
        version: "0.1.0",
        build: 1,
        schemes: ["vibevalley"],
        capabilities: { network: ["https://*"], notifications: true },
        ios: { deploymentTarget: "17.0" },
        android: { minSdk: 28 },
        theme: "design/theme.json",
      };
      writeFileSync(join(tempDir, "apps/mobile/nsh.json"), `${JSON.stringify(mobileManifest, null, 2)}\n`, "utf8");

      const driftedBefore = runTokensGen(false, tempDir);
      expect(driftedBefore).toContain(join(tempDir, "apps/mobile/design/theme.json"));
      expect(driftedBefore).toContain(join(tempDir, "apps/mobile/nsh.json"));
      expect(runTokensGen(true, tempDir)).toEqual([]);

      const updatedMobile = JSON.parse(readFileSync(join(tempDir, "apps/mobile/nsh.json"), "utf8")) as Record<string, unknown>;
      expect(updatedMobile.id).toBe(mobileManifest.id);
      expect(updatedMobile.name).toBe(mobileManifest.name);
      expect(updatedMobile.schemes).toEqual(mobileManifest.schemes);
      expect(updatedMobile.capabilities).toEqual(mobileManifest.capabilities);
      expect(updatedMobile.ios).toEqual(mobileManifest.ios);
      expect(updatedMobile.android).toEqual(mobileManifest.android);
      expect(updatedMobile.tailwind).toBeDefined();
      expect(readFileSync(join(tempDir, "apps/mobile/design/theme.json"), "utf8")).toBe(readFileSync(join(tempDir, "apps/mac/ui/design/theme.json"), "utf8"));
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("is deterministic and matches all committed targets", () => {
    const first = generateTokenTargets(tokens);
    const second = generateTokenTargets(tokens);
    expect(first).toEqual(second);
    for (const target of first) {
      expect(readFileSync(target.path, "utf8"), target.path).toBe(target.content);
    }
  });
});
