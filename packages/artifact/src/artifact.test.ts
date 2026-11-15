import { describe, expect, it } from "vite-plus/test";

import { t } from "@vibevalley/i18n";
import { keyBetween } from "@vibevalley/protocol/rules";
import { artifactId, blockId } from "@vibevalley/protocol/schema";

import { codePointOffset, editSpans, markdownShortcut } from "./blocks.ts";
import { artifactSuffixOf, canvasEdit, inferArtifactFromName, inferDisplayFromContent, normalizeWhiteboardContent } from "./html.ts";
import { blocksOfMarkdown, htmlCheck, htmlEdit, inlineSpans, markdownOf, ordered, Page, selectionOf, splitAt } from "./index.ts";
import { CanvasPaletteValues, shellMessageOf, shellPath, withShell } from "./shell.ts";

describe("@vibevalley/artifact domain engine", () => {
  it("applies block operations, splits spans at code points, and round-trips Markdown", () => {
    const aid = artifactId("00000000-0000-4000-a000-000000000001");
    const b1 = blockId("00000000-0000-4000-a000-000000000011");
    const b2 = blockId("00000000-0000-4000-a000-000000000012");
    const firstKey = keyBetween("", "");
    const page = new Page(aid, "user", 1000, []);

    expect(
      page.apply({
        op: "insert_block",
        block: {
          id: b1,
          orderKey: firstKey,
          type: "heading",
          attrs: { level: 2 },
          text: inlineSpans("Hello **world**"),
        },
      }).status,
    ).toBe("applied");

    expect(
      page.apply({
        op: "insert_block",
        block: {
          id: b2,
          orderKey: keyBetween(firstKey, ""),
          type: "todo",
          attrs: { checked: true },
          text: inlineSpans("Ship `@vibevalley/artifact`"),
        },
      }).status,
    ).toBe("applied");

    const md = markdownOf(ordered([...page.blocks.values()]));
    expect(md).toBe("## Hello **world**\n\n- [x] Ship `@vibevalley/artifact`\n");
    const parsed = blocksOfMarkdown(md);
    expect(parsed.map((b) => [b.type, b.attrs])).toEqual([
      ["heading", { level: 2 }],
      ["todo", { checked: true }],
    ]);

    const [left, right] = splitAt(inlineSpans("😀bold"), 1);
    expect([left[0]?.t, right[0]?.t]).toEqual(["😀", "bold"]);
  });

  it("checks HTML CSP safety, applies anchor edits, and handles editor span shortcuts", () => {
    const html = "<!doctype html><html><body><p>First paragraph</p><iframe src='https://evil.example'></iframe></body></html>";
    const checked = htmlCheck(html);
    expect(checked.refused).toEqual([{ kind: "frame", line: 1, tag: "iframe" }]);

    const edited = htmlEdit("<p>Hello world</p>", { kind: "text", exact: "world", prefix: "Hello ", suffix: "" }, "farm");
    expect(edited).toEqual({ ok: true, source: "<p>Hello farm</p>" });

    expect(selectionOf({ vibevalley: "selection", anchor: { kind: "text", exact: "hi", prefix: "a", suffix: "b" } })).toEqual({
      kind: "text",
      exact: "hi",
      prefix: "a",
      suffix: "b",
    });

    expect(codePointOffset("😀abc", 2)).toBe(1);
    expect(markdownShortcut("### Title")).toEqual({ type: "heading", attrs: { level: 3 }, strip: 4 });
    expect(editSpans([{ t: "hello", marks: { bold: true } }], "hello!")).toEqual([{ t: "hello!", marks: { bold: true } }]);
  });

  it("hears only the shell protocol's messages from a page, and serves the page with its runtime", () => {
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
    expect(withShell({ page: "<p>hi</p>", display: "page", theme: "dark" })).toMatch(
      /^<p>hi<\/p>\n<style>:root\{[^}]*--vv-page:#151413[^]*\(\{ display: "page" \}\)/u,
    );
    expect(shellPath("a", 3, "slides", "dark")).toBe("/api/v1/artifact/a/3?shell=1&display=slides&theme=dark");
  });

  it("validates <vv-board>, <vv-assets>, <vv-layer> lint rules and preserves network warning shape", () => {
    const valid = [
      '<vv-assets><svg id="hero" viewBox="0 0 10 10"></svg></vv-assets>',
      '<vv-board width="1200" height="1600" palette="workbench">',
      '  <vv-layer id="bg" x="0" y="0" w="1200" h="1600" bleed></vv-layer>',
      '  <vv-layer id="art" x="40" y="40" w="300" h="300" asset="hero"></vv-layer>',
      '  <vv-layer id="headline" x="400" y="80" w="600" h="120"><h1>Harvest</h1></vv-layer>',
      "</vv-board>",
    ].join("\n");
    expect(htmlCheck(valid)).toEqual({ refused: [], warned: [] });

    const missingAsset = '<vv-board width="800" height="600"><vv-layer id="a" x="0" y="0" w="100" h="100" asset="nope"></vv-layer></vv-board>';
    expect(htmlCheck(missingAsset).refused).toEqual([{ kind: "canvasAssetMissing", line: 1, id: "a", asset: "nope" }]);

    const badIdsAndBox = [
      '<vv-board width="0" height="600">',
      '  <vv-layer id="" x="0" y="0" w="100" h="100"></vv-layer>',
      '  <vv-layer id="dup" x="10" y="20" w="100" h="100"></vv-layer>',
      '  <vv-layer id="dup" x="10" y="20" w="-5" h="100"></vv-layer>',
      "</vv-board>",
    ].join("\n");
    expect(htmlCheck(badIdsAndBox).refused).toEqual([
      { kind: "canvasBoardAttr", line: 1 },
      { kind: "canvasLayerId", line: 2, id: "" },
      { kind: "canvasLayerId", line: 4, id: "dup" },
      { kind: "canvasLayerBox", line: 4, id: "dup" },
    ]);

    const hugeData = "data:image/png;base64," + "a".repeat(2100);
    const inlineDataHtml = `<vv-board width="400" height="400"><vv-layer id="img" x="0" y="0" w="100" h="100"><img src="${hugeData}"></vv-layer></vv-board>`;
    expect(htmlCheck(inlineDataHtml).refused).toEqual([{ kind: "canvasInlineData", line: 1 }]);

    const withWarnings = [
      '<vv-board width="500" height="500">',
      '  <vv-layer id="pic" x="50" y="50" w="200" h="200"><svg></svg></vv-layer>',
      '  <vv-layer id="copy" x="100" y="100" w="450" h="120"><p>Overlap and out of bounds</p></vv-layer>',
      "</vv-board>",
      "<script>fetch('https://api.example.com/data')</script>",
    ].join("\n");
    const checked = htmlCheck(withWarnings);
    expect(checked.refused).toEqual([]);
    expect(checked.warned.map((w) => w.call)).toEqual(["fetch", "canvas-bounds", "canvas-occlusion"]);
    const netWarning = checked.warned.find((w) => w.call === "fetch");
    expect(netWarning).toEqual({ line: 5, call: "fetch" });
    expect("message" in (netWarning ?? {})).toBe(false);
  });

  it("round-trips canvas layer and board edits into <vv-board> HTML source", () => {
    const source = [
      '<vv-board width="1200" height="1600" palette="workbench">',
      '  <vv-layer id="title" x="100" y="120" w="600" h="80"><h1>Hello Farm</h1></vv-layer>',
      '  <vv-layer id="badge" x="20" y="20" w="80" h="80" z="1"></vv-layer>',
      "</vv-board>",
    ].join("\n");

    const updated = canvasEdit(source, {
      board: { palette: "blueprint", grain: 0.35 },
      layers: [
        { id: "title", x: 140, y: 160, flip: "x", z: 3, text: "Spring Harvest" },
        { id: "badge", locked: true, hidden: true },
      ],
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) throw new Error(updated.why);
    expect(updated.source).toContain('palette="blueprint"');
    expect(updated.source).toContain('grain="0.35"');
    expect(updated.source).toContain('x="140"');
    expect(updated.source).toContain('y="160"');
    expect(updated.source).toContain('flip="x"');
    expect(updated.source).toContain('z="3"');
    expect(updated.source).toContain("<h1>Spring Harvest</h1></vv-layer>");
    expect(updated.source).toContain("locked");
    expect(updated.source).toContain("hidden");

    const multi = `<vv-board width="1200" height="800">
  <vv-layer id="card" x="40" y="40" w="400" h="160">
    <h3>Title</h3>
    <p class="sub">Subtitle</p>
  </vv-layer>
</vv-board>`;
    const multiEdited = canvasEdit(multi, { layers: [{ id: "card", text: "Updated Title\nUpdated <Sub>" }] });
    expect(multiEdited.ok).toBe(true);
    if (!multiEdited.ok) throw new Error(multiEdited.why);
    expect(multiEdited.source).toContain("<h3>Updated Title</h3>");
    expect(multiEdited.source).toContain('<p class="sub">Updated &lt;Sub&gt;</p>');

    const missingBoard = canvasEdit("<div>no board</div>", { layers: [{ id: "x", x: 1 }] });
    expect(missingBoard.ok).toBe(false);
    const missingLayer = canvasEdit(source, { layers: [{ id: "unknown", x: 1 }] });
    expect(missingLayer.ok).toBe(false);
  });

  it("decodes canvas shell messages, injects canvas runtime, and exposes canvasEditor translations", () => {
    const canvasState = {
      width: 1200,
      height: 1600,
      palette: "brutalist-red",
      grain: 0.2,
      selectedId: "title",
      layers: [
        {
          id: "title",
          name: "title",
          kind: "layer",
          x: 100,
          y: 120,
          w: 600,
          h: 80,
          rotate: 0,
          z: 1,
          opacity: 1,
          flip: "none",
          filter: "none",
          locked: false,
          hidden: false,
          hasAsset: false,
          text: "",
        },
      ],
      issues: [{ kind: "collision", layerId: "title", otherLayerId: "art", message: "Overlap" }],
    };

    expect(shellMessageOf({ vibevalley: "ready", display: "canvas", canvas: canvasState })).toMatchObject({
      vibevalley: "ready",
      display: "canvas",
      canvas: { palette: "brutalist-red", selectedId: "title" },
    });
    expect(shellMessageOf({ vibevalley: "at", canvas: canvasState })).toMatchObject({
      vibevalley: "at",
      canvas: { width: 1200, height: 1600 },
    });
    expect(shellMessageOf({ vibevalley: "ready", display: "canvas", canvas: { ...canvasState, palette: "unknown" } })).toBeUndefined();

    expect(CanvasPaletteValues).toEqual(["workbench", "brutalist-red", "newsprint", "blueprint"]);
    const shelled = withShell({
      page: '<vv-board width="800" height="600"></vv-board>',
      display: "canvas",
      theme: "light",
    });
    expect(shelled).toContain("vv-canvas");
    expect(shelled).toContain("vv-assets");
    expect(shelled).toContain('({ display: "canvas" })');

    const keys = [
      t("web.artifact.canvasEditor.layers"),
      t("web.artifact.canvasEditor.palette"),
      t("web.artifact.canvasEditor.paletteWorkbench"),
      t("web.artifact.canvasEditor.paletteBrutalistRed"),
      t("web.artifact.canvasEditor.paletteNewsprint"),
      t("web.artifact.canvasEditor.paletteBlueprint"),
      t("web.artifact.canvasEditor.flipX"),
      t("web.artifact.canvasEditor.bringForward"),
      t("web.artifact.canvasEditor.sendBackward"),
      t("web.artifact.canvasEditor.lock"),
      t("web.artifact.canvasEditor.unlock"),
      t("web.artifact.canvasEditor.hide"),
      t("web.artifact.canvasEditor.show"),
      t("web.artifact.canvasEditor.lintClean"),
      t("web.artifact.canvasEditor.lintIssues", { count: 2 }),
      t("web.artifact.canvasEditor.autoFix"),
      t("web.artifact.canvasEditor.saveChanges"),
      t("web.artifact.canvasEditor.resetChanges"),
      t("web.artifact.canvasEditor.exportSvg"),
    ];
    for (const label of keys) expect(label.length).toBeGreaterThan(0);
    expect(t("web.artifact.canvasEditor.lintIssues", { count: 2 })).toContain("2");
  });

  it("infers compound artifact extensions, formats canonical suffixes, and normalizes whiteboard JSON", () => {
    expect(inferArtifactFromName("q3-deck.slide.html")).toEqual({ title: "q3-deck", kind: "html", display: "slides" });
    expect(inferArtifactFromName("poster.visual.html")).toEqual({ title: "poster", kind: "html", display: "canvas" });
    expect(inferArtifactFromName("kpi.dashboard.html")).toEqual({ title: "kpi", kind: "html", display: "dashboard" });
    expect(inferArtifactFromName("intro.motion.html")).toEqual({ title: "intro", kind: "html", display: "motion" });
    expect(inferArtifactFromName("pipeline.whiteboard")).toEqual({ title: "pipeline", kind: "html", display: "whiteboard" });
    expect(inferArtifactFromName("notes.doc.md")).toEqual({ title: "notes", kind: "markdown" });
    expect(inferArtifactFromName("plain.html", '<vv-board data-mode="dashboard" width="1200" height="800"></vv-board>')).toEqual({
      title: "plain",
      kind: "html",
      display: "dashboard",
    });
    expect(inferDisplayFromContent('<vv-board data-mode="whiteboard"><vv-edge from="a" to="b"></vv-edge></vv-board>')).toBe("whiteboard");

    expect(artifactSuffixOf({ body: "blocks" })).toBe(".doc.md");
    expect(artifactSuffixOf({ body: "html", display: "canvas" })).toBe(".visual.html");
    expect(artifactSuffixOf({ body: "html", display: "slides" })).toBe(".slide.html");
    expect(artifactSuffixOf({ body: "html", display: "dashboard" })).toBe(".dashboard.html");
    expect(artifactSuffixOf({ body: "html", display: "motion" })).toBe(".motion.html");
    expect(artifactSuffixOf({ body: "html", display: "whiteboard" })).toBe(".whiteboard");
    expect(artifactSuffixOf({ body: "html", display: "page" })).toBe(".html");

    const wbHtml = normalizeWhiteboardContent(
      JSON.stringify({
        width: 1400,
        height: 900,
        palette: "workbench",
        nodes: [
          { id: "n1", label: "Issue", text: "Define scope", x: 100, y: 120, w: 220, h: 110, tone: "leaf" },
          { id: "n2", label: "Worktree", text: "Branch & patch", x: 460, y: 120, kind: "pill", tone: "water" },
        ],
        edges: [{ from: "n1", to: "n2", label: "dispatch", style: "dashed" }],
      }),
      "Pipeline",
    );
    expect(wbHtml).toContain('<vv-board data-mode="whiteboard" width="1400" height="900" palette="workbench">');
    expect(wbHtml).toContain('<vv-edge id="edge-1" from="n1" to="n2" label="dispatch" data-style="dashed"></vv-edge>');
    expect(wbHtml).toContain('<vv-layer id="n1" name="Issue" x="100" y="120" w="220" h="110" z="4" data-node-kind="rect" data-tone="leaf">');
    expect(htmlCheck(wbHtml).refused).toEqual([]);
    expect(withShell({ page: wbHtml, display: "whiteboard", theme: "light" })).toContain('({ display: "whiteboard" })');
    expect(withShell({ page: "<vv-board width='800' height='600'></vv-board>", display: "dashboard", theme: "dark" })).toContain('({ display: "dashboard" })');
  });
});
