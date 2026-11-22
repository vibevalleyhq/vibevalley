import "../../infra/polyfill";
import { expect, test } from "nsh/test";

import { userId } from "@vibevalley/protocol";

import { codePointOffset, editSpans, markdownShortcut } from "./blocks";
import { artifactSuffixOf, inferArtifactFromName, inferDisplayFromContent } from "./html";
import { presenceHighlightCommand, selectionOf, shellMessageOf } from "./shell";
import { storeMessageOf } from "./viewers";

test("handles editor span shortcuts and UTF-16 code-point offsets", () => {
  expect(codePointOffset("😀abc", 2)).toBe(1);
  expect(markdownShortcut("### Title")).toEqual({ type: "heading", attrs: { level: 3 }, strip: 4 });
  expect(editSpans([{ t: "hello", marks: { bold: true } }], "hello!")).toEqual([{ t: "hello!", marks: { bold: true } }]);
});

test("hears only the shell and store protocol messages from a frame", () => {
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

test("infers compound artifact extensions and formats canonical suffixes", () => {
  expect(inferArtifactFromName("q3-deck.slide.html")).toEqual({ title: "q3-deck", kind: "html", display: "slides", artifactType: "slides" });
  expect(inferArtifactFromName("poster.visual.html")).toEqual({ title: "poster", kind: "html", display: "page", artifactType: "design" });
  expect(inferArtifactFromName("kpi.dashboard.html")).toEqual({ title: "kpi", kind: "html", display: "page", artifactType: "dashboard" });
  expect(inferArtifactFromName("intro.motion.html")).toEqual({ title: "intro", kind: "html", display: "motion", artifactType: "motion" });
  expect(inferArtifactFromName("pipeline.whiteboard")).toEqual({ title: "pipeline", kind: "html", display: "page", artifactType: "whiteboard" });
  expect(inferArtifactFromName("brand.tokens.json")).toEqual({ title: "brand", kind: "html", display: "page", artifactType: "design-system" });
  expect(inferArtifactFromName("weekly.outline.md")).toEqual({ title: "weekly", kind: "markdown", artifactType: "outline" });
  expect(inferArtifactFromName("notes.doc.md")).toEqual({ title: "notes", kind: "markdown", artifactType: "docs" });
  expect(inferArtifactFromName("plain.html", "<script>vv.timeline(5, () => {})</script>")).toEqual({
    title: "plain",
    kind: "html",
    display: "motion",
  });
  expect(inferDisplayFromContent("<section><h1>One</h1></section><section><h2>Two</h2></section>")).toBe("slides");
  expect(inferDisplayFromContent("<p>Just a page</p>")).toBeUndefined();

  expect(artifactSuffixOf({ body: "blocks" })).toBe(".doc.md");
  expect(artifactSuffixOf({ body: "blocks", artifactType: "outline" })).toBe(".outline.md");
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

test("presenceHighlightCommand filters local user, scopes by path, and normalizes highlight colors", () => {
  const cmd = presenceHighlightCommand(
    [
      { id: userId, name: "Me", kind: "highlight", selector: "#local", updatedAt: 1 },
      { id: "session:1", name: "老周", color: "coral", kind: "highlight", selector: ".kpi-card", status: "核对指标", path: "slides/01.html", updatedAt: 2 },
      { id: "session:2", name: "小美", color: "#2f9d8f", kind: "cursor", x: 120, y: 80, w: 64, h: 32, path: "slides/02.html", updatedAt: 3 },
      { id: "session:3", name: "助手", color: "teal", kind: "selection", x: 10, y: 20, updatedAt: 4 },
    ],
    { path: "slides/01.html" },
  );
  expect(cmd).toEqual({
    vibevalley: "presence-highlight",
    items: [
      { id: "session:1", name: "老周", color: "#d9774f", selector: ".kpi-card", status: "核对指标" },
      { id: "session:3", name: "助手", color: "#2f9d8f", x: 10, y: 20 },
    ],
  });
});
