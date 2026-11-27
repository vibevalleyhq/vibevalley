import "../../../infra/polyfill";
import { describe, expect, open, test } from "nsh/test";

import { setLocale } from "@vibevalley/i18n";
import "@vibevalley/i18n/catalogs";
import type { DocBlock, Issue } from "@vibevalley/protocol";
import { issueId } from "@vibevalley/protocol/schema";

import {
  addTableColumn,
  addTableRow,
  appendChildToToggle,
  applyWikilinkReplacement,
  buildChartSpecJson,
  computeDocStats,
  computeSlideIndices,
  createDefaultBlock,
  cycleTableAlignment,
  deleteBlockById,
  detectSlashTrigger,
  detectWikilinkTrigger,
  duplicateBlockById,
  extractTocEntries,
  filterIssuesForList,
  filterSlashCommands,
  formatWikilinkToken,
  insertBlockAfter,
  matchMarkdownInputRule,
  moveBlockById,
  parseInlineLinkSegments,
  removeTableColumn,
  removeTableRow,
  setColumnsCount,
  SLASH_COMMANDS,
  stripSlashTrigger,
  turnBlockInto,
  updateTableCell,
  updateTableHeader,
} from "./docOps";

const ALL_24_BLOCK_TYPES: readonly DocBlock["type"][] = [
  "prose",
  "heading",
  "list",
  "todo",
  "quote",
  "divider",
  "toggle",
  "callout",
  "code",
  "table",
  "bookmark",
  "toc",
  "math",
  "columns",
  "pageBreak",
  "kpi",
  "chart",
  "diagram",
  "compare",
  "media",
  "preview",
  "baseEmbed",
  "issueCard",
  "issueList",
];

describe("docOps: 24 BlockKinds, Markdown rules, Turn Into, Slash & Wikilink ops", () => {
  test("covers all 24 BlockKinds in SLASH_COMMANDS and createDefaultBlock", () => {
    const slashTypes = new Set(SLASH_COMMANDS.map((c) => c.type));
    for (const type of ALL_24_BLOCK_TYPES) {
      expect(slashTypes.has(type)).toBe(true);
      const created = createDefaultBlock(type, { id: `id_${type}` });
      expect(created.id).toBe(`id_${type}`);
      expect(created.type).toBe(type);
    }
    expect(SLASH_COMMANDS.filter((c) => c.category === "basic").length).toBeGreaterThanOrEqual(8);
    expect(SLASH_COMMANDS.filter((c) => c.category === "structure").length).toBeGreaterThanOrEqual(8);
    expect(SLASH_COMMANDS.filter((c) => c.category === "data").length).toBeGreaterThanOrEqual(8);
  });

  test("filterSlashCommands filters by label, shortcut, and pinyin alias", () => {
    expect(filterSlashCommands("").length).toBe(SLASH_COMMANDS.length);
    expect(filterSlashCommands("##").some((c) => c.key === "heading-2")).toBe(true);
    expect(filterSlashCommands("gongshi").some((c) => c.type === "math")).toBe(true);
    expect(filterSlashCommands("kpi").some((c) => c.type === "kpi")).toBe(true);
    expect(filterSlashCommands("nonexistent-xyz").length).toBe(0);
  });

  test("matchMarkdownInputRule converts all prose prefixes accurately", () => {
    expect(matchMarkdownInputRule("# Title", "b1")?.block).toEqual({ id: "b1", type: "heading", level: 1, text: "Title" });
    expect(matchMarkdownInputRule("## Sub", "b1")?.block).toEqual({ id: "b1", type: "heading", level: 2, text: "Sub" });
    expect(matchMarkdownInputRule("### Deep", "b1")?.block).toEqual({ id: "b1", type: "heading", level: 3, text: "Deep" });
    expect(matchMarkdownInputRule("- item", "b1")?.block).toEqual({ id: "b1", type: "list", ordered: false, items: ["item"] });
    expect(matchMarkdownInputRule("1. first", "b1")?.block).toEqual({ id: "b1", type: "list", ordered: true, items: ["first"] });
    expect(matchMarkdownInputRule("[] task", "b1")?.block).toEqual({ id: "b1", type: "todo", checked: false, text: "task" });
    expect(matchMarkdownInputRule("- [x] done", "b1")?.block).toEqual({ id: "b1", type: "todo", checked: true, text: "done" });
    expect(matchMarkdownInputRule("> quote me", "b1")?.block).toEqual({ id: "b1", type: "quote", text: "quote me" });
    expect(matchMarkdownInputRule("---", "b1")?.block).toEqual({ id: "b1", type: "divider" });
    expect(matchMarkdownInputRule("$$", "b1")?.block).toEqual({ id: "b1", type: "math", expression: "", display: true });
    expect(matchMarkdownInputRule("```rust ", "b1")?.block).toEqual({ id: "b1", type: "code", language: "rust", code: "" });
    expect(matchMarkdownInputRule("```mermaid", "b1", true)?.block).toEqual({
      id: "b1",
      type: "diagram",
      source: "flowchart LR\n  A --> B",
    });
    expect(matchMarkdownInputRule("plain text", "b1")).toBeUndefined();
  });

  test("turnBlockInto converts across text-compatible blocks while preserving text and id", () => {
    const prose: DocBlock = { id: "blk_1", type: "prose", text: "Ship note editor" };
    const asHeading = turnBlockInto(prose, "heading", { headingLevel: 2 });
    expect(asHeading).toEqual({ id: "blk_1", type: "heading", level: 2, text: "Ship note editor" });

    const asQuote = turnBlockInto(asHeading, "quote");
    expect(asQuote).toEqual({ id: "blk_1", type: "quote", text: "Ship note editor" });

    const asTodo = turnBlockInto(asQuote, "todo");
    expect(asTodo).toEqual({ id: "blk_1", type: "todo", checked: false, text: "Ship note editor" });

    const asToggle = turnBlockInto(asTodo, "toggle");
    expect(asToggle.type).toBe("toggle");
    if (asToggle.type === "toggle") {
      expect(asToggle.title).toBe("Ship note editor");
    }

    const asCode = turnBlockInto(asToggle, "code");
    expect(asCode).toEqual({ id: "blk_1", type: "code", language: "plaintext", code: "Ship note editor" });

    const asList = turnBlockInto({ id: "blk_2", type: "prose", text: "One\nTwo" }, "list", { listOrdered: true });
    expect(asList).toEqual({ id: "blk_2", type: "list", ordered: true, items: ["One", "Two"] });
  });

  test("slash trigger, wikilink trigger, formatting, and inline link segment parsing", () => {
    const slash = detectSlashTrigger("Hello /tab");
    expect(slash).toEqual({ query: "tab", triggerIndex: 6 });
    expect(stripSlashTrigger("Hello /tab", slash!.triggerIndex)).toBe("Hello");

    const wiki = detectWikilinkTrigger("See [[arch");
    expect(wiki).toEqual({ mode: "wikilink", query: "arch", startIndex: 4 });
    const token = formatWikilinkToken("note", "n1", "Architecture");
    expect(token).toBe("[[note:n1|Architecture]]");
    expect(applyWikilinkReplacement("See [[arch", wiki!.startIndex, token)).toBe("See [[note:n1|Architecture]] ");

    expect(detectWikilinkTrigger("![[base")).toEqual({ mode: "embed", query: "base", startIndex: 0 });
    expect(detectWikilinkTrigger("Fix #42")).toEqual({ mode: "issue", query: "42", startIndex: 4 });

    const segs = parseInlineLinkSegments("Open [[note:n1|Spec]], ![[issue:i2|Bug]], and #42 at https://x.dev/#99.");
    expect(segs).toEqual([
      { kind: "text", value: "Open " },
      { kind: "note", id: "n1", label: "Spec", embed: false },
      { kind: "text", value: ", " },
      { kind: "issue", id: "i2", label: "Bug", embed: true },
      { kind: "text", value: ", and " },
      { kind: "issueNumber", number: 42 },
      { kind: "text", value: " at https://x.dev/#99." },
    ]);
  });

  test("table, toggle, columns, TOC, stats, and recursive tree CRUD operations", () => {
    let table = createDefaultBlock("table", { id: "t1" });
    if (table.type !== "table") throw new Error("expected table");
    table = addTableRow(table);
    expect(table.rows.length).toBe(3);
    table = removeTableRow(table, 0);
    expect(table.rows.length).toBe(2);
    table = addTableColumn(table);
    expect(table.headers.length).toBe(3);
    expect(table.rows[0]?.length).toBe(3);
    table = updateTableHeader(table, 2, "Score");
    table = updateTableCell(table, 0, 2, "99");
    table = cycleTableAlignment(table, 2);
    expect(table.headers[2]).toBe("Score");
    expect(table.rows[0]?.[2]).toBe("99");
    expect(table.alignments?.[2]).toBe("center");
    table = removeTableColumn(table, 2);
    expect(table.headers.length).toBe(2);

    let cols = createDefaultBlock("columns", { id: "c1" });
    if (cols.type !== "columns") throw new Error("expected columns");
    cols = setColumnsCount(cols, 3);
    expect(cols.columns.length).toBe(3);
    cols = setColumnsCount(cols, 2);
    expect(cols.columns.length).toBe(2);

    const tree: DocBlock[] = [
      { id: "h1", type: "heading", level: 1, text: "Intro" },
      {
        id: "tg1",
        type: "toggle",
        title: "Details",
        text: "Body",
        collapsed: true,
        children: [{ id: "h2", type: "heading", level: 2, text: "Nested Heading" }],
      },
      { id: "pb1", type: "pageBreak", title: "Slide Two" },
      { id: "h3", type: "heading", level: 3, text: "Deep Heading" },
    ];

    const withChild = appendChildToToggle(tree, "tg1", { id: "p_child", type: "prose", text: "Added child" });
    expect(withChild[1]?.collapsed).toBe(false);
    expect(withChild[1]?.children?.length).toBe(2);

    expect(extractTocEntries(withChild, 2)).toEqual([
      { blockId: "h1", level: 1, text: "Intro" },
      { blockId: "h2", level: 2, text: "Nested Heading" },
    ]);
    expect(extractTocEntries(withChild, 3).length).toBe(3);

    const stats = computeDocStats(withChild);
    expect(stats.blockCount).toBe(6);
    expect(stats.slideCount).toBe(2);
    expect(stats.wordCount).toBeGreaterThanOrEqual(8);
    expect(computeSlideIndices(withChild).get("pb1")).toBe(2);

    const inserted = insertBlockAfter(tree, "h2", { id: "p_after", type: "prose", text: "After nested" });
    expect(inserted[1]?.children?.map((c) => c.id)).toEqual(["h2", "p_after"]);

    const moved = moveBlockById(tree, "h1", "down");
    expect(moved[0]?.id).toBe("tg1");
    expect(moved[1]?.id).toBe("h1");

    const duped = duplicateBlockById(tree, "h1");
    expect(duped.length).toBe(5);
    expect(duped[1]?.id).not.toBe("h1");

    const deleted = deleteBlockById(tree, "h2");
    expect(deleted[1]?.children?.length).toBe(0);

    const chart = createDefaultBlock("chart", { id: "ch1" });
    if (chart.type !== "chart") throw new Error("expected chart");
    const parsedChart = JSON.parse(buildChartSpecJson(chart, 500)) as { type: string; width: number; categories: string[] };
    expect(parsedChart.type).toBe("bar");
    expect(parsedChart.width).toBe(500);
    expect(parsedChart.categories).toEqual(["Mon", "Tue", "Wed"]);

    const fakeIssues: Issue[] = [
      {
        id: issueId("i1"),
        number: 1,
        title: "One",
        description: "",
        repo: "r1",
        mandate: { strength: "explicit", maxBotReviewRounds: 0, autoSubmitPr: false },
        status: "todo",
        moves: [],
        priority: "medium",
        deliver: "change",
        criteria: [],
        checks: [],
        questions: [],
        findings: [],
        assignments: [],
        blockedBy: [],
        tags: ["ui"],
        createdAt: 0,
        stage: { state: "draft", acts: [] },
      },
      {
        id: issueId("i2"),
        number: 2,
        title: "Two",
        description: "",
        repo: "r2",
        mandate: { strength: "explicit", maxBotReviewRounds: 0, autoSubmitPr: false },
        status: "done",
        moves: [],
        priority: "low",
        deliver: "change",
        criteria: [],
        checks: [],
        questions: [],
        findings: [],
        assignments: [],
        blockedBy: [],
        tags: ["rust"],
        createdAt: 0,
        stage: { state: "done", acts: [] },
      },
    ];
    expect(filterIssuesForList(fakeIssues, { repo: "r1", tag: "ui" }).map((i) => i.number)).toEqual([1]);
    expect(filterIssuesForList(fakeIssues, { status: "done" }).map((i) => i.number)).toEqual([2]);
  });
});

describe("BlockDocView UI: 24 blocks, slash menu, wikilink, markdown rules, gutter, backlinks, debounced save", () => {
  test("renders all 24 blocks, header stats, presenter button, inline links, TOC, and backlinks", async () => {
    setLocale("en");
    const app = await open("./doc.story.tsx", {
      width: 1100,
      height: 860,
      colorScheme: "light",
      platform: "macos",
    });

    expect(app.count("id:note-block-doc-view")).toBe(1);
    expect(app.count("id:doc-cover-strip")).toBe(1);
    expect(app.count("id:doc-presenter-btn")).toBe(1);
    expect(app.count("id:doc-toc-b_toc")).toBe(1);
    expect(app.count("id:doc-heading-b_h1")).toBe(1);
    expect(app.count("id:doc-prose-rich-b_prose")).toBe(1);
    expect(app.count("id:doc-list-b_list")).toBe(1);
    expect(app.count("id:doc-todo-b_todo")).toBe(1);
    expect(app.count("id:doc-quote-b_quote")).toBe(1);
    expect(app.count("id:doc-divider-b_div")).toBe(1);
    expect(app.count("id:doc-toggle-b_toggle")).toBe(1);
    expect(app.count("id:doc-callout-b_callout")).toBe(1);
    expect(app.count("id:doc-code-b_code")).toBe(1);
    expect(app.count("id:doc-table-b_table")).toBe(1);
    expect(app.count("id:doc-bookmark-b_bookmark")).toBe(1);
    expect(app.count("id:doc-math-b_math")).toBe(1);
    expect(app.count("id:doc-columns-b_cols")).toBe(1);
    expect(app.count("id:doc-page-break-b_pb")).toBe(1);
    expect(app.count("id:doc-kpi-b_kpi")).toBe(1);
    expect(app.count("id:doc-chart-b_chart")).toBe(1);
    expect(app.count("id:doc-diagram-b_diagram")).toBe(1);
    expect(app.count("id:doc-compare-b_compare")).toBe(1);
    expect(app.count("id:doc-media-b_media")).toBe(1);
    expect(app.count("id:doc-preview-b_preview")).toBe(1);
    expect(app.count("id:doc-base-embed-b_base")).toBe(1);
    expect(app.count("id:doc-issue-card-b_issue_card")).toBe(1);
    expect(app.count("id:doc-issue-list-b_issue_list")).toBe(1);

    // TOC respects maxLevel=2 (shows Overview, hides H3 Deep Subsection until switched to H3).
    expect(app.count("id:doc-toc-entry-b_h1")).toBe(1);
    expect(app.count("id:doc-toc-entry-b_h3")).toBe(0);
    await app.press("id:doc-toc-level-3-b_toc");
    await app.waitFor("id:doc-toc-entry-b_h3");

    // Presenter button triggers onOpenPresenter.
    await app.press("id:doc-presenter-btn");
    await app.waitFor("text:openPresenter");

    // Clicking inline note pill and issue pill triggers navigation callbacks.
    await app.press("id:doc-inline-note-note-ref-2");
    await app.waitFor("text:openNote:note-ref-2");
    await app.press("id:doc-inline-issue-42");
    await app.waitFor("text:openIssue:issue-101");

    // Clicking BaseEmbed and IssueCard triggers navigation callbacks.
    await app.press("id:doc-base-embed-open-b_base");
    await app.waitFor("text:openNote:note-base-1");
    await app.press("id:doc-issue-card-open-issue-101");
    await app.waitFor("text:openIssue:issue-101");

    // Backlinks & Outgoing Links panel triggers navigation callbacks.
    expect(app.count("id:doc-links-panel")).toBe(1);
    await app.press("id:doc-link-backlink-l_back_1");
    await app.waitFor("text:openNote:note-ref-2");
    await app.press("id:doc-link-outgoing-l_out_1");
    await app.waitFor("text:openIssue:issue-101");
  });

  test("supports Markdown input rules, Slash menu keyboard/click, Wikilink menu, Table/Toggle/Math ops, Gutter Turn Into, and debounced save", async () => {
    setLocale("en");
    const app = await open("./doc.story.tsx", {
      width: 1100,
      height: 860,
      colorScheme: "light",
      platform: "macos",
    });

    // Initially zero saves.
    expect(app.texts()).toContain("saves:0");

    // 1. Markdown rule: typing "# " into empty prose block b_prose_edit converts it to a heading!
    await app.type("id:doc-block-input-b_prose_edit", "# ");
    await app.waitFor("id:doc-heading-b_prose_edit");
    await app.type("id:doc-block-input-b_prose_edit", "Instant Heading");
    await app.waitFor("text:saves:1");

    // 2. Toggle collapse / expand and add child block.
    expect(app.count("id:doc-toggle-body-b_toggle")).toBe(1);
    await app.press("id:doc-toggle-btn-b_toggle");
    await app.waitFor("id:doc-toggle-body-b_toggle", { state: "gone" });
    await app.press("id:doc-toggle-btn-b_toggle");
    await app.waitFor("id:doc-toggle-body-b_toggle");

    // 3. Table add row / add col.
    await app.press("id:doc-table-add-row-b_table");
    await app.waitFor("id:doc-table-cell-b_table-1-0");
    await app.press("id:doc-table-add-col-b_table");
    await app.waitFor("id:doc-table-header-b_table-2");

    // 4. Math edit/render toggle.
    await app.press("id:doc-math-edit-b_math");
    await app.waitFor("id:doc-math-input-b_math");
    await app.press("id:doc-math-edit-b_math");
    await app.waitFor("id:doc-math-preview-b_math");

    // 5. Gutter menu: Turn Into + Convert to Issue.
    await app.press("id:doc-gutter-menu-b_prose_edit");
    await app.waitFor("id:doc-turn-into-quote-b_prose_edit");
    await app.press("id:doc-turn-into-quote-b_prose_edit");
    await app.waitFor("id:doc-quote-b_prose_edit");

    await app.press("id:doc-gutter-menu-b_prose_edit");
    await app.waitFor("id:doc-menu-issue-b_prose_edit");
    await app.press("id:doc-menu-issue-b_prose_edit");
    await app.waitFor("text:createIssue:b_prose_edit:Instant Heading");

    // 6. Slash Menu with '/', fuzzy filter, Enter keyboard selection, and conversion.
    await app.type("id:doc-block-input-b_prose_slash", "/call");
    await app.waitFor("id:doc-slash-menu-b_prose_slash");
    await app.waitFor("id:doc-slash-item-callout");
    await app.keyboard.press("enter");
    await app.waitFor("id:doc-callout-b_prose_slash");

    // 7. Wikilink Menu with '[[', filter, and insert note link pill.
    await app.type("id:doc-block-input-b_prose_wiki", "Check [[Guild");
    await app.waitFor("id:doc-wikilink-menu-b_prose_wiki");
    await app.waitFor("id:doc-wikilink-item-note:note-ref-2");
    await app.press("id:doc-wikilink-item-note:note-ref-2");
    await app.waitFor("id:doc-wikilink-menu-b_prose_wiki", { state: "gone" });

    // 8. Title rename + Append block + debounced save.
    await app.type("id:doc-title-input", " v2");
    await app.keyboard.press("enter");
    await app.waitFor("text:renamed:Architecture Spec v2");

    await app.press("id:doc-append-block-btn");
    await app.waitFor("text:savedBlocks:29");
  });
});
