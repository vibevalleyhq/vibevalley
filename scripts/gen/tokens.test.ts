import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { flattenPixelTheme, generateTokenTargets, parseDesignTokens, renderNshJson } from "./tokens.ts";

const root = resolve(import.meta.dirname, "../..");

describe("design/tokens.json generator", () => {
  const tokens = parseDesignTokens(readFileSync(resolve(root, "design/tokens.json"), "utf8"));

  it("preserves all 110 original pixel theme keys plus avatar ground tokens in theme.json", () => {
    const theme = flattenPixelTheme(tokens);
    expect(Object.keys(theme)).toHaveLength(112);
    expect(theme.white).toBe("#fff");
    expect(theme["cream-50"]).toBe("#f7e8c4");
    expect(theme["avatar-leaf"]).toBe("#dcebc8");
    expect(theme["avatar-sky"]).toBe("#cfe6f5");
    expect(theme["lcd-ink"]).toBe("#22341a");
    expect(theme["glow-soft"]).toBe("#f3e2b8");
  });

  it("preserves nsh.json non-tailwind metadata and capabilities untouched", () => {
    const currentNsh = readFileSync(resolve(root, "apps/mac/ui/nsh.json"), "utf8");
    const parsedCurrent = JSON.parse(currentNsh) as Record<string, unknown>;
    const rendered = JSON.parse(renderNshJson(tokens, currentNsh)) as Record<string, unknown>;

    expect(rendered.name).toBe(parsedCurrent.name);
    expect(rendered.id).toBe(parsedCurrent.id);
    expect(rendered.version).toBe(parsedCurrent.version);
    expect(rendered.build).toBe(parsedCurrent.build);
    expect(rendered.capabilities).toEqual(parsedCurrent.capabilities);
    expect(rendered.theme).toBe(parsedCurrent.theme);
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
