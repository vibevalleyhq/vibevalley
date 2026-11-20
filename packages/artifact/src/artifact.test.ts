import { describe, expect, it } from "vite-plus/test";

import {
  artifactSuffixOf,
  codePointOffset,
  editSpans,
  inferArtifactFromName,
  inferDisplayFromContent,
  markdownShortcut,
  selectionOf,
  shellMessageOf,
  storeMessageOf,
} from "./index.ts";

describe("@vibevalley/artifact UI helpers", () => {
  it("handles editor span shortcuts and UTF-16 code-point offsets", () => {
    expect(codePointOffset("😀abc", 2)).toBe(1);
    expect(markdownShortcut("### Title")).toEqual({ type: "heading", attrs: { level: 3 }, strip: 4 });
    expect(editSpans([{ t: "hello", marks: { bold: true } }], "hello!")).toEqual([{ t: "hello!", marks: { bold: true } }]);
  });

  it("hears only the shell and store protocol messages from a frame", () => {
    expect(selectionOf({ vibevalley: "selection", anchor: { kind: "text", exact: "hi", prefix: "a", suffix: "b" } })).toEqual({
      kind: "text",
      exact: "hi",
      prefix: "a",
      suffix: "b",
    });
    expect(shellMessageOf({ vibevalley: "ready", display: "slides", pages: 5, titles: ["a"], notes: [""] })).toMatchObject({ pages: 5 });
    expect(shellMessageOf({ vibevalley: "at", page: 2 })).toEqual({ vibevalley: "at", page: 2 });
    expect(shellMessageOf({ vibevalley: "ready", display: "motion", duration: 12.5 })).toMatchObject({ duration: 12.5 });
    for (const other of [
      null,
      { vibevalley: "ready", display: "poster" },
      { vibevalley: "ready", display: "slides", pages: -1 },
      { vibevalley: "ready", display: "slides", pages: 1.5 },
      { vibevalley: "at", time: Number.POSITIVE_INFINITY },
      { vibevalley: "goto", page: 1 },
      { vibevalley: "navigate", href: "/settings" },
    ])
      expect(shellMessageOf(other)).toBeUndefined();

    expect(storeMessageOf({ vibevalley: "store-mark-click", source: "sales", field: "rev" })).toEqual({
      vibevalley: "store-mark-click",
      source: "sales",
      field: "rev",
    });
    expect(storeMessageOf({ vibevalley: "unknown" })).toBeUndefined();
  });

  it("infers compound artifact extensions and formats canonical suffixes", () => {
    expect(inferArtifactFromName("q3-deck.slide.html")).toEqual({ title: "q3-deck", kind: "html", display: "slides", artifactType: "slides" });
    expect(inferArtifactFromName("poster.visual.html")).toEqual({ title: "poster", kind: "html", display: "page", artifactType: "design" });
    expect(inferArtifactFromName("kpi.dashboard.html")).toEqual({ title: "kpi", kind: "html", display: "page", artifactType: "dashboard" });
    expect(inferArtifactFromName("intro.motion.html")).toEqual({ title: "intro", kind: "html", display: "motion", artifactType: "motion" });
    expect(inferArtifactFromName("pipeline.whiteboard")).toEqual({ title: "pipeline", kind: "html", display: "page", artifactType: "whiteboard" });
    expect(inferArtifactFromName("brand.tokens.json")).toEqual({ title: "brand", kind: "html", display: "page", artifactType: "design-system" });
    expect(inferArtifactFromName("notes.doc.md")).toEqual({ title: "notes", kind: "markdown", artifactType: "docs" });
    expect(inferArtifactFromName("plain.html", "<script>vv.timeline(5, () => {})</script>")).toEqual({
      title: "plain",
      kind: "html",
      display: "motion",
    });
    expect(inferDisplayFromContent("<section><h1>One</h1></section><section><h2>Two</h2></section>")).toBe("slides");
    expect(inferDisplayFromContent("<p>Just a page</p>")).toBeUndefined();

    expect(artifactSuffixOf({ body: "blocks" })).toBe(".doc.md");
    expect(artifactSuffixOf({ body: "store", artifactType: "docs" })).toBe(".doc.md");
    expect(artifactSuffixOf({ body: "store", artifactType: "slides" })).toBe(".slide.html");
    expect(artifactSuffixOf({ body: "store", artifactType: "dashboard" })).toBe(".dashboard.html");
    expect(artifactSuffixOf({ body: "store", artifactType: "motion" })).toBe(".motion.html");
    expect(artifactSuffixOf({ body: "store", artifactType: "whiteboard" })).toBe(".whiteboard");
    expect(artifactSuffixOf({ body: "store", artifactType: "design" })).toBe(".visual.html");
    expect(artifactSuffixOf({ body: "store", artifactType: "design-system" })).toBe(".design-system.json");
    expect(artifactSuffixOf({ body: "html", display: "page" })).toBe(".html");
    expect(artifactSuffixOf({ body: "html", display: "slides" })).toBe(".slide.html");
    expect(artifactSuffixOf({ body: "html", display: "motion" })).toBe(".motion.html");
  });
});
