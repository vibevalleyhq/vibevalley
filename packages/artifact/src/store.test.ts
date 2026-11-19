import { describe, expect, it } from "vite-plus/test";

import { artifactId } from "@vibevalley/protocol/schema";

import { motionRecorderHelper, withShell } from "./shell.ts";
import { starterEntriesForType } from "./starters.ts";
import { applyJsonMergePatch, type ArtifactEntry, type ArtifactTypeValues, entryPathProblem, inferEntryKind } from "./store.ts";
import { compileTokensCss, contrastRatio, parseTokensSpec } from "./tokens.ts";
import { renderStoreArtifactHtml, sanitizeWhiteboardSvg, storeHtmlProblem, storeViewHeaders, writePropsIntoDcHtml } from "./viewers.ts";

const aid = artifactId("00000000-0000-4000-a000-000000000099");

function materialize(type: (typeof ArtifactTypeValues)[number]): ArtifactEntry[] {
  return starterEntriesForType(type, "Demo").map((w, i) => ({
    artifactId: aid,
    path: w.path,
    kind: w.kind ?? inferEntryKind(w.path),
    mime: "text/plain",
    size: (w.value ?? "").length,
    rev: i + 1,
    updatedBy: "user",
    updated: 1000,
    ...(w.value !== undefined ? { value: w.value } : {}),
  }));
}

describe("@vibevalley/artifact structured store & viewers", () => {
  it("validates store paths and applies RFC 7396 JSON merge patches", () => {
    expect(entryPathProblem("project/slides/s01.html")).toBeUndefined();
    expect(entryPathProblem("/leading")).toMatch(/leading/u);
    expect(entryPathProblem("project/../secret")).toMatch(/dot/u);
    expect(entryPathProblem("a//b")).toMatch(/empty/u);

    const patched = applyJsonMergePatch(
      JSON.stringify({ x: 10, y: 20, label: "Box", meta: { color: "leaf", locked: true } }),
      JSON.stringify({ x: 42, label: null, meta: { locked: false } }),
    );
    expect(patched.ok).toBe(true);
    if (patched.ok) {
      expect(JSON.parse(patched.value)).toEqual({ x: 42, y: 20, meta: { color: "leaf", locked: false } });
    }
  });

  it("compiles design-system tokens into light/dark CSS variables and computes WCAG contrast", () => {
    const tokensValue = starterEntriesForType("design-system", "Brand").find((e) => e.path === "project/tokens.json")?.value ?? "{}";
    const spec = parseTokensSpec(tokensValue);
    expect(spec.colors.length).toBeGreaterThanOrEqual(4);
    const css = compileTokensCss(tokensValue);
    expect(css).toContain('[data-theme="light"]');
    expect(css).toContain('[data-theme="dark"]');
    expect(css).toContain("--color-accent:");
    expect(css).toContain(".type-display{");
    expect(contrastRatio("#1c1917", "#fcfcfb")).toBeGreaterThan(12);
  });

  it("sanitizes whiteboard SVGs, updates .dc.html data-props, and enforces sandbox CSP", () => {
    const dirtySvg = `<svg viewBox="0 0 100 100" onload="alert(1)"><script>evil()</script><rect width="50" height="50" onclick="bad()" /><a href="https://evil.example"><text>Hi</text></a></svg>`;
    const cleanSvg = sanitizeWhiteboardSvg(dirtySvg);
    expect(cleanSvg).not.toContain("<script");
    expect(cleanSvg).not.toContain("onload");
    expect(cleanSvg).not.toContain("onclick");
    expect(cleanSvg).toContain("<rect");

    const dc = `<x-dc data-props='[{"name":"density","type":"select","options":["comfortable","compact"],"value":"comfortable"}]'><div>Body</div></x-dc>`;
    const updated = writePropsIntoDcHtml(dc, { density: "compact" });
    expect(updated).toContain('"value":"compact"');

    expect(storeHtmlProblem(`<img src="assets/logo.png"><img src="/api/v1/attachment/a1">`)).toBe("");
    expect(storeHtmlProblem(`<img src="https://evil.example/pixel.png">`)).not.toBe("");

    const headers = storeViewHeaders("http://127.0.0.1:8787", false, "allow-scripts allow-popups allow-popups-to-escape-sandbox");
    expect(headers["content-security-policy"]).toContain("sandbox allow-scripts");
    expect(headers["content-security-policy"]).not.toContain("allow-same-origin");
    expect(headers["content-security-policy"]).toContain("connect-src 'none'");
  });

  it("renders valid sandboxed HTML across slides, dashboard, motion, design, and design-system", () => {
    for (const type of ["slides", "dashboard", "motion", "design", "design-system"] as const) {
      const html = renderStoreArtifactHtml(type, materialize(type), { theme: "light" });
      expect(html).toContain("<!doctype html>");
    }
  });

  it("negotiates WebKit video/mp4 fallback in motionRecorderHelper and injects motion preload in withShell", () => {
    expect(motionRecorderHelper).toContain('"video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm", "video/mp4"');
    const motionPage = withShell({ page: "<!doctype html><html><head></head><body></body></html>", display: "motion", theme: "dark" });
    expect(motionPage).toContain("<head><script>window.__vvEarly = null;");
    expect(motionPage).toContain('({ display: "motion" })');
  });
});
