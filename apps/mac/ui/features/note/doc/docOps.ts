import { t } from "@vibevalley/i18n";
import type { DocBlock, DocColumn, DocKpiItem, Issue } from "@vibevalley/protocol";
import { issueId, noteId } from "@vibevalley/protocol/schema";

import type { IconName } from "../../../design/icons";
import { matches } from "../../../infra/base/search";

export type BlockType = DocBlock["type"];
export type SlashCategory = "basic" | "structure" | "data";
export type CalloutTone = "info" | "tip" | "warn" | "danger" | "note";
export type TableAlignment = "left" | "center" | "right" | "";

export interface SlashCommandItem {
  readonly key: string;
  readonly type: BlockType;
  readonly headingLevel?: 1 | 2 | 3;
  readonly listOrdered?: boolean;
  readonly category: SlashCategory;
  readonly label: string;
  readonly description: string;
  readonly shortcut?: string;
  readonly icon: IconName;
  readonly keywords: readonly string[];
}

const SLASH_CATEGORIES: readonly SlashCategory[] = ["basic", "structure", "data"];

export const SLASH_COMMANDS: readonly SlashCommandItem[] = [
  {
    key: "prose",
    type: "prose",
    category: "basic",
    label: "Text",
    description: "Plain paragraph with [[wikilinks]] and #issue refs",
    icon: "edit",
    keywords: ["paragraph", "text", "prose", "p", "wenben", "duanluo"],
  },
  {
    key: "heading-1",
    type: "heading",
    headingLevel: 1,
    category: "basic",
    label: "Heading 1",
    description: "Large section heading",
    shortcut: "#",
    icon: "notes",
    keywords: ["h1", "heading", "title", "biaoti"],
  },
  {
    key: "heading-2",
    type: "heading",
    headingLevel: 2,
    category: "basic",
    label: "Heading 2",
    description: "Medium section heading",
    shortcut: "##",
    icon: "notes",
    keywords: ["h2", "heading", "subtitle", "erjibiaoti"],
  },
  {
    key: "heading-3",
    type: "heading",
    headingLevel: 3,
    category: "basic",
    label: "Heading 3",
    description: "Small subsection heading",
    shortcut: "###",
    icon: "notes",
    keywords: ["h3", "heading", "sanjibiaoti"],
  },
  {
    key: "list-bullet",
    type: "list",
    listOrdered: false,
    category: "basic",
    label: "Bulleted List",
    description: "Unordered list of items",
    shortcut: "-",
    icon: "log",
    keywords: ["ul", "bullet", "list", "liebiao"],
  },
  {
    key: "list-ordered",
    type: "list",
    listOrdered: true,
    category: "basic",
    label: "Numbered List",
    description: "Ordered list with numbers",
    shortcut: "1.",
    icon: "log",
    keywords: ["ol", "ordered", "numbered", "list", "youxuliebiao"],
  },
  {
    key: "todo",
    type: "todo",
    category: "basic",
    label: "To-do",
    description: "Checkable task item",
    shortcut: "[]",
    icon: "ticked",
    keywords: ["todo", "task", "checkbox", "daiban"],
  },
  {
    key: "quote",
    type: "quote",
    category: "basic",
    label: "Quote",
    description: "Blockquote with optional attribution",
    shortcut: ">",
    icon: "reply",
    keywords: ["quote", "blockquote", "citation", "yinyong"],
  },
  {
    key: "divider",
    type: "divider",
    category: "basic",
    label: "Divider",
    description: "Visual horizontal separator",
    shortcut: "---",
    icon: "minus",
    keywords: ["divider", "hr", "line", "separator", "fengexian"],
  },
  {
    key: "toggle",
    type: "toggle",
    category: "structure",
    label: "Toggle",
    description: "Collapsible section with nested blocks",
    icon: "expand",
    keywords: ["toggle", "collapse", "details", "zhedie"],
  },
  {
    key: "callout",
    type: "callout",
    category: "structure",
    label: "Callout",
    description: "Highlighted notice box with tone",
    icon: "info",
    keywords: ["callout", "notice", "alert", "tip", "tishi"],
  },
  {
    key: "code",
    type: "code",
    category: "structure",
    label: "Code",
    description: "Syntax-highlighted code block",
    shortcut: "```",
    icon: "terminal",
    keywords: ["code", "fence", "snippet", "daima"],
  },
  {
    key: "table",
    type: "table",
    category: "structure",
    label: "Table",
    description: "Editable grid with column alignment",
    icon: "catalog",
    keywords: ["table", "grid", "biaoge"],
  },
  {
    key: "bookmark",
    type: "bookmark",
    category: "structure",
    label: "Bookmark",
    description: "Rich web link card",
    icon: "link",
    keywords: ["bookmark", "url", "link", "shuqian"],
  },
  {
    key: "toc",
    type: "toc",
    category: "structure",
    label: "Table of Contents",
    description: "Live outline from document headings",
    icon: "sidebarRight",
    keywords: ["toc", "outline", "contents", "mulu"],
  },
  {
    key: "math",
    type: "math",
    category: "structure",
    label: "Math Formula",
    description: "LaTeX equation block",
    shortcut: "$$",
    icon: "understand",
    keywords: ["math", "latex", "formula", "equation", "gongshi"],
  },
  {
    key: "columns",
    type: "columns",
    category: "structure",
    label: "Columns",
    description: "Side-by-side 2-3 column layout",
    icon: "sidebar",
    keywords: ["columns", "grid", "layout", "fenlan"],
  },
  {
    key: "pageBreak",
    type: "pageBreak",
    category: "structure",
    label: "Slide Page Break",
    description: "Split document into presentation slides",
    icon: "present",
    keywords: ["pagebreak", "slide", "presenter", "fenye"],
  },
  {
    key: "kpi",
    type: "kpi",
    category: "data",
    label: "KPI Metrics",
    description: "Numeric metric summary cards",
    icon: "spend",
    keywords: ["kpi", "metric", "stat", "zhibiao"],
  },
  {
    key: "chart",
    type: "chart",
    category: "data",
    label: "Chart",
    description: "Bar or line chart visualization",
    icon: "generate",
    keywords: ["chart", "graph", "bar", "line", "tubiao"],
  },
  {
    key: "diagram",
    type: "diagram",
    category: "data",
    label: "Diagram",
    description: "Mermaid flowchart or architecture diagram",
    icon: "branch",
    keywords: ["diagram", "mermaid", "flowchart", "jiagoutu"],
  },
  {
    key: "compare",
    type: "compare",
    category: "data",
    label: "Before / After Compare",
    description: "Visual side-by-side or slider diff",
    icon: "diff",
    keywords: ["compare", "diff", "before", "after", "duibi"],
  },
  {
    key: "media",
    type: "media",
    category: "data",
    label: "Media",
    description: "Image, audio, or video embed",
    icon: "image",
    keywords: ["media", "image", "audio", "video", "tupian"],
  },
  {
    key: "preview",
    type: "preview",
    category: "data",
    label: "Sandbox Preview",
    description: "Isolated HTML prototype preview",
    icon: "web",
    keywords: ["preview", "html", "prototype", "yulan"],
  },
  {
    key: "baseEmbed",
    type: "baseEmbed",
    category: "data",
    label: "Base Embed",
    description: "Embed a VibeValley Base table",
    icon: "folder",
    keywords: ["base", "embed", "database", "duoweiku"],
  },
  {
    key: "issueCard",
    type: "issueCard",
    category: "data",
    label: "Issue Card",
    description: "Embed a live Issue card",
    icon: "issues",
    keywords: ["issue", "card", "gongdan"],
  },
  {
    key: "issueList",
    type: "issueList",
    category: "data",
    label: "Issue List",
    description: "Filtered live Issue query list",
    icon: "filter",
    keywords: ["issue", "list", "query", "gongdanliebiao"],
  },
];

let blockIdCounter = 0;

export function makeBlockId(prefix = "blk"): string {
  blockIdCounter += 1;
  return `${prefix}_${Date.now().toString(36)}_${blockIdCounter}`;
}

export function createDefaultBlock(
  type: BlockType,
  opts?: { readonly id?: string; readonly headingLevel?: 1 | 2 | 3; readonly listOrdered?: boolean },
): DocBlock {
  const id = opts?.id ?? makeBlockId();
  switch (type) {
    case "prose":
      return { id, type: "prose", text: "" };
    case "heading":
      return { id, type: "heading", level: opts?.headingLevel ?? 1, text: "" };
    case "list":
      return { id, type: "list", ordered: opts?.listOrdered === true, items: [""] };
    case "todo":
      return { id, type: "todo", checked: false, text: "" };
    case "quote":
      return { id, type: "quote", text: "" };
    case "divider":
      return { id, type: "divider" };
    case "toggle":
      return { id, type: "toggle", title: "", text: "", collapsed: false, children: [] };
    case "callout":
      return { id, type: "callout", tone: "info", text: "" };
    case "code":
      return { id, type: "code", language: "typescript", code: "" };
    case "table":
      return {
        id,
        type: "table",
        headers: ["Column 1", "Column 2"],
        rows: [
          ["", ""],
          ["", ""],
        ],
        alignments: ["left", "left"],
      };
    case "bookmark":
      return { id, type: "bookmark", url: "https://vibevalley.dev", title: "VibeValley" };
    case "toc":
      return { id, type: "toc", maxLevel: 3 };
    case "math":
      return { id, type: "math", expression: "E = mc^2", display: true };
    case "columns":
      return {
        id,
        type: "columns",
        columns: [{ blocks: [{ id: makeBlockId("col"), type: "prose", text: "" }] }, { blocks: [{ id: makeBlockId("col"), type: "prose", text: "" }] }],
      };
    case "pageBreak":
      return { id, type: "pageBreak", title: "Next Slide", speakerNotes: "" };
    case "kpi":
      return {
        id,
        type: "kpi",
        items: [{ label: "Metric", value: "0", delta: "+0%", tone: "ok" }],
      };
    case "chart":
      return {
        id,
        type: "chart",
        title: "Metrics",
        kind: "bar",
        labels: ["Mon", "Tue", "Wed"],
        series: [{ name: "Series 1", data: [12, 18, 24] }],
      };
    case "diagram":
      return {
        id,
        type: "diagram",
        title: "Flow",
        source: "flowchart LR\n  A[Start] --> B[Done]",
      };
    case "compare":
      return {
        id,
        type: "compare",
        title: "Visual Compare",
        beforeLabel: "Before",
        afterLabel: "After",
        beforeAsset: "",
        afterAsset: "",
      };
    case "media":
      return { id, type: "media", mediaKind: "image", src: "", caption: "" };
    case "preview":
      return { id, type: "preview", entry: "structure/index.html", height: 280, title: "Preview" };
    case "baseEmbed":
      return { id, type: "baseEmbed", noteId: noteId("") };
    case "issueCard":
      return { id, type: "issueCard", issueId: issueId("") };
    case "issueList":
      return { id, type: "issueList", limit: 10 };
  }
}

function slashCategoryLabel(category: SlashCategory): string {
  switch (category) {
    case "basic":
      return t("web.note.doc.slashCat.basic");
    case "structure":
      return t("web.note.doc.slashCat.structure");
    case "data":
      return t("web.note.doc.slashCat.data");
  }
}

export function slashCommandLabel(key: string): string {
  switch (key) {
    case "prose":
      return t("web.note.doc.slash.prose.label");
    case "heading-1":
      return t("web.note.doc.slash.heading1.label");
    case "heading-2":
      return t("web.note.doc.slash.heading2.label");
    case "heading-3":
      return t("web.note.doc.slash.heading3.label");
    case "list-bullet":
      return t("web.note.doc.slash.listBullet.label");
    case "list-ordered":
      return t("web.note.doc.slash.listOrdered.label");
    case "todo":
      return t("web.note.doc.slash.todo.label");
    case "quote":
      return t("web.note.doc.slash.quote.label");
    case "divider":
      return t("web.note.doc.slash.divider.label");
    case "toggle":
      return t("web.note.doc.slash.toggle.label");
    case "callout":
      return t("web.note.doc.slash.callout.label");
    case "code":
      return t("web.note.doc.slash.code.label");
    case "table":
      return t("web.note.doc.slash.table.label");
    case "bookmark":
      return t("web.note.doc.slash.bookmark.label");
    case "toc":
      return t("web.note.doc.slash.toc.label");
    case "math":
      return t("web.note.doc.slash.math.label");
    case "columns":
      return t("web.note.doc.slash.columns.label");
    case "pageBreak":
      return t("web.note.doc.slash.pageBreak.label");
    case "kpi":
      return t("web.note.doc.slash.kpi.label");
    case "chart":
      return t("web.note.doc.slash.chart.label");
    case "diagram":
      return t("web.note.doc.slash.diagram.label");
    case "compare":
      return t("web.note.doc.slash.compare.label");
    case "media":
      return t("web.note.doc.slash.media.label");
    case "preview":
      return t("web.note.doc.slash.preview.label");
    case "baseEmbed":
      return t("web.note.doc.slash.baseEmbed.label");
    case "issueCard":
      return t("web.note.doc.slash.issueCard.label");
    case "issueList":
      return t("web.note.doc.slash.issueList.label");
    default:
      return key;
  }
}

export function slashCommandDesc(key: string): string {
  switch (key) {
    case "prose":
      return t("web.note.doc.slash.prose.desc");
    case "heading-1":
      return t("web.note.doc.slash.heading1.desc");
    case "heading-2":
      return t("web.note.doc.slash.heading2.desc");
    case "heading-3":
      return t("web.note.doc.slash.heading3.desc");
    case "list-bullet":
      return t("web.note.doc.slash.listBullet.desc");
    case "list-ordered":
      return t("web.note.doc.slash.listOrdered.desc");
    case "todo":
      return t("web.note.doc.slash.todo.desc");
    case "quote":
      return t("web.note.doc.slash.quote.desc");
    case "divider":
      return t("web.note.doc.slash.divider.desc");
    case "toggle":
      return t("web.note.doc.slash.toggle.desc");
    case "callout":
      return t("web.note.doc.slash.callout.desc");
    case "code":
      return t("web.note.doc.slash.code.desc");
    case "table":
      return t("web.note.doc.slash.table.desc");
    case "bookmark":
      return t("web.note.doc.slash.bookmark.desc");
    case "toc":
      return t("web.note.doc.slash.toc.desc");
    case "math":
      return t("web.note.doc.slash.math.desc");
    case "columns":
      return t("web.note.doc.slash.columns.desc");
    case "pageBreak":
      return t("web.note.doc.slash.pageBreak.desc");
    case "kpi":
      return t("web.note.doc.slash.kpi.desc");
    case "chart":
      return t("web.note.doc.slash.chart.desc");
    case "diagram":
      return t("web.note.doc.slash.diagram.desc");
    case "compare":
      return t("web.note.doc.slash.compare.desc");
    case "media":
      return t("web.note.doc.slash.media.desc");
    case "preview":
      return t("web.note.doc.slash.preview.desc");
    case "baseEmbed":
      return t("web.note.doc.slash.baseEmbed.desc");
    case "issueCard":
      return t("web.note.doc.slash.issueCard.desc");
    case "issueList":
      return t("web.note.doc.slash.issueList.desc");
    default:
      return "";
  }
}

export function filterSlashCommands(query: string): readonly SlashCommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((item) =>
    matches(q, [slashCommandLabel(item.key), slashCommandDesc(item.key), item.label, item.description, item.type, item.shortcut, ...item.keywords]),
  );
}

export function groupSlashCommands(
  items: readonly SlashCommandItem[],
): readonly { readonly category: SlashCategory; readonly label: string; readonly items: readonly SlashCommandItem[] }[] {
  const out: { category: SlashCategory; label: string; items: SlashCommandItem[] }[] = [];
  for (const cat of SLASH_CATEGORIES) {
    const matched = items.filter((item) => item.category === cat);
    if (matched.length > 0) {
      out.push({ category: cat, label: slashCategoryLabel(cat), items: matched });
    }
  }
  return out;
}

export interface MarkdownRuleResult {
  readonly block: DocBlock;
}

/** Matches Notion-style Markdown prefix shortcuts in a `prose` block. */
export function matchMarkdownInputRule(text: string, blockId: string, onEnter = false): MarkdownRuleResult | undefined {
  if (/^###\s(.*)$/u.test(text)) {
    const m = /^###\s(.*)$/u.exec(text);
    return { block: { id: blockId, type: "heading", level: 3, text: m?.[1] ?? "" } };
  }
  if (/^##\s(.*)$/u.test(text)) {
    const m = /^##\s(.*)$/u.exec(text);
    return { block: { id: blockId, type: "heading", level: 2, text: m?.[1] ?? "" } };
  }
  if (/^#\s(.*)$/u.test(text)) {
    const m = /^#\s(.*)$/u.exec(text);
    return { block: { id: blockId, type: "heading", level: 1, text: m?.[1] ?? "" } };
  }
  if (/^-\s\[x\]\s(.*)$/iu.test(text)) {
    const m = /^-\s\[x\]\s(.*)$/iu.exec(text);
    return { block: { id: blockId, type: "todo", checked: true, text: m?.[1] ?? "" } };
  }
  if (/^(?:-\s)?\[\s?\]\s(.*)$/u.test(text)) {
    const m = /^(?:-\s)?\[\s?\]\s(.*)$/u.exec(text);
    return { block: { id: blockId, type: "todo", checked: false, text: m?.[1] ?? "" } };
  }
  if (/^[-*]\s(.*)$/u.test(text)) {
    const m = /^[-*]\s(.*)$/u.exec(text);
    return { block: { id: blockId, type: "list", ordered: false, items: [m?.[1] ?? ""] } };
  }
  if (/^1\.\s(.*)$/u.test(text)) {
    const m = /^1\.\s(.*)$/u.exec(text);
    return { block: { id: blockId, type: "list", ordered: true, items: [m?.[1] ?? ""] } };
  }
  if (/^>\s(.*)$/u.test(text)) {
    const m = /^>\s(.*)$/u.exec(text);
    return { block: { id: blockId, type: "quote", text: m?.[1] ?? "" } };
  }
  if (text === "---" || text === "***") {
    return { block: { id: blockId, type: "divider" } };
  }
  if (text === "$$" || text === "$$ ") {
    return { block: { id: blockId, type: "math", expression: "", display: true } };
  }
  const fenceMatch = onEnter ? /^```([a-zA-Z0-9_-]*)$/u.exec(text.trim()) : /^```([a-zA-Z0-9_-]*)\s$/u.exec(text);
  if (fenceMatch || text === "```") {
    const lang = (fenceMatch?.[1] ?? "").trim();
    if (lang.toLowerCase() === "mermaid") {
      return { block: { id: blockId, type: "diagram", source: "flowchart LR\n  A --> B" } };
    }
    return { block: { id: blockId, type: "code", language: lang || "plaintext", code: "" } };
  }
  return undefined;
}

export interface SlashTrigger {
  readonly query: string;
  readonly triggerIndex: number;
}

export function detectSlashTrigger(text: string): SlashTrigger | undefined {
  const m = /(?:^|\s)\/([^\s/]*)$/u.exec(text);
  if (!m) return undefined;
  const full = m[0];
  const slashOffset = full.indexOf("/");
  return {
    query: m[1] ?? "",
    triggerIndex: m.index + slashOffset,
  };
}

export function stripSlashTrigger(text: string, triggerIndex: number): string {
  return text.slice(0, triggerIndex).trimEnd();
}

export type WikilinkMode = "wikilink" | "embed" | "issue";

export interface WikilinkTrigger {
  readonly mode: WikilinkMode;
  readonly query: string;
  readonly startIndex: number;
}

export function detectWikilinkTrigger(text: string): WikilinkTrigger | undefined {
  const embed = /!\[\[([^[\]]*)$/u.exec(text);
  if (embed) {
    return { mode: "embed", query: embed[1] ?? "", startIndex: embed.index };
  }
  const wiki = /\[\[([^[\]]*)$/u.exec(text);
  if (wiki) {
    return { mode: "wikilink", query: wiki[1] ?? "", startIndex: wiki.index };
  }
  const issue = /(?:^|[\s([,:;])#([a-zA-Z0-9_-]*)$/u.exec(text);
  if (issue) {
    const hashOffset = issue[0].lastIndexOf("#");
    return { mode: "issue", query: issue[1] ?? "", startIndex: issue.index + hashOffset };
  }
  return undefined;
}

export function formatWikilinkToken(kind: "note" | "issue", id: string, label: string, embed = false): string {
  const cleanLabel = label.replaceAll("|", "/").replaceAll("]]", "").trim();
  const prefix = embed ? "![[" : "[[";
  return cleanLabel ? `${prefix}${kind}:${id}|${cleanLabel}]]` : `${prefix}${kind}:${id}]]`;
}

export function applyWikilinkReplacement(text: string, startIndex: number, token: string): string {
  const before = text.slice(0, startIndex);
  const needsSpace = before.length > 0 && !/\s$/u.test(before) && !before.endsWith("(") && !before.endsWith("[");
  return `${before}${needsSpace ? " " : ""}${token} `;
}

export type InlineSegment =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "note"; readonly id: string; readonly label: string; readonly embed: boolean }
  | { readonly kind: "issue"; readonly id: string; readonly label: string; readonly embed: boolean }
  | { readonly kind: "issueNumber"; readonly number: number };

const INLINE_TOKEN_RE = /(!?\[\[(note|issue):([^\]|]+?)(?:\|([^\]]*))?\]\])|((?:^|[\s([,:;])#(\d+)(?![a-zA-Z0-9_]))/gu;

export function parseInlineLinkSegments(text: string): readonly InlineSegment[] {
  if (!text) return [];
  const out: InlineSegment[] = [];
  let cursor = 0;
  INLINE_TOKEN_RE.lastIndex = 0;
  for (;;) {
    const m = INLINE_TOKEN_RE.exec(text);
    if (!m) break;
    if (m[1] !== undefined) {
      if (m.index > cursor) {
        out.push({ kind: "text", value: text.slice(cursor, m.index) });
      }
      const embed = m[1].startsWith("!");
      const kind = m[2] === "note" ? "note" : "issue";
      const rawId = (m[3] ?? "").trim();
      const id = kind === "issue" ? rawId.replace(/^#/u, "") : rawId;
      const alias = m[4]?.trim() ?? "";
      out.push({
        kind,
        id,
        label: alias || (kind === "issue" ? `#${id}` : id),
        embed,
      });
      cursor = m.index + m[1].length;
    } else if (m[5] !== undefined && m[6] !== undefined) {
      const hashPos = m[5].lastIndexOf("#");
      const tokenStart = m.index + hashPos;
      if (tokenStart > cursor) {
        out.push({ kind: "text", value: text.slice(cursor, tokenStart) });
      }
      const num = Number.parseInt(m[6], 10);
      out.push({ kind: "issueNumber", number: num });
      cursor = tokenStart + 1 + m[6].length;
    }
  }
  if (cursor < text.length) {
    out.push({ kind: "text", value: text.slice(cursor) });
  }
  return out;
}

export interface TurnIntoOption {
  readonly key: string;
  readonly type: BlockType;
  readonly headingLevel?: 1 | 2 | 3;
  readonly listOrdered?: boolean;
  readonly label: string;
  readonly icon: IconName;
}

export const TURN_INTO_OPTIONS: readonly TurnIntoOption[] = [
  { key: "prose", type: "prose", label: "Text", icon: "edit" },
  { key: "heading-1", type: "heading", headingLevel: 1, label: "Heading 1", icon: "notes" },
  { key: "heading-2", type: "heading", headingLevel: 2, label: "Heading 2", icon: "notes" },
  { key: "heading-3", type: "heading", headingLevel: 3, label: "Heading 3", icon: "notes" },
  { key: "list-bullet", type: "list", listOrdered: false, label: "Bulleted List", icon: "log" },
  { key: "list-ordered", type: "list", listOrdered: true, label: "Numbered List", icon: "log" },
  { key: "todo", type: "todo", label: "To-do", icon: "ticked" },
  { key: "quote", type: "quote", label: "Quote", icon: "reply" },
  { key: "toggle", type: "toggle", label: "Toggle", icon: "expand" },
  { key: "callout", type: "callout", label: "Callout", icon: "info" },
  { key: "code", type: "code", label: "Code", icon: "terminal" },
  { key: "math", type: "math", label: "Math Formula", icon: "understand" },
];

function extractBlockText(block: DocBlock): string {
  switch (block.type) {
    case "prose":
    case "heading":
    case "todo":
    case "quote":
    case "callout":
      return block.text;
    case "list":
      return block.items.join("\n");
    case "toggle":
      return block.title || block.text;
    case "code":
      return block.code;
    case "math":
      return block.expression;
    case "diagram":
      return block.source;
    case "bookmark":
      return block.title || block.url;
    case "pageBreak":
      return block.title ?? "";
    case "table":
      return block.headers.join(" | ");
    case "kpi":
      return block.items.map((i) => `${i.label}: ${i.value}`).join(", ");
    case "chart":
    case "compare":
    case "preview":
      return block.title ?? "";
    case "media":
      return block.caption ?? "";
    case "divider":
    case "toc":
    case "columns":
    case "baseEmbed":
    case "issueCard":
    case "issueList":
      return "";
  }
}

export function extractBlockTitle(block: DocBlock): string {
  const raw = extractBlockText(block).split(/\r?\n/u)[0]?.trim() ?? "";
  return raw || `Block ${block.type}`;
}

export function turnBlockInto(block: DocBlock, targetType: BlockType, opts?: { readonly headingLevel?: 1 | 2 | 3; readonly listOrdered?: boolean }): DocBlock {
  const text = extractBlockText(block);
  const extra = block.children !== undefined && block.children.length > 0 ? { children: block.children } : {};
  switch (targetType) {
    case "prose":
      return { id: block.id, type: "prose", text, ...extra };
    case "heading":
      return {
        id: block.id,
        type: "heading",
        level: opts?.headingLevel ?? (block.type === "heading" ? block.level : 1),
        text: text.replaceAll("\n", " "),
        ...extra,
      };
    case "list": {
      const items = text ? text.split(/\r?\n/u) : [""];
      return { id: block.id, type: "list", ordered: opts?.listOrdered === true, items, ...extra };
    }
    case "todo":
      return { id: block.id, type: "todo", checked: block.type === "todo" ? block.checked : false, text: text.replaceAll("\n", " "), ...extra };
    case "quote":
      return {
        id: block.id,
        type: "quote",
        text,
        ...(block.type === "quote" && block.attribution !== undefined ? { attribution: block.attribution } : {}),
        ...extra,
      };
    case "toggle":
      return {
        id: block.id,
        type: "toggle",
        title: block.type === "toggle" ? block.title : (text.split(/\r?\n/u)[0] ?? ""),
        text: block.type === "toggle" ? block.text : text.split(/\r?\n/u).slice(1).join("\n"),
        collapsed: block.collapsed ?? false,
        children: block.children ?? [],
      };
    case "callout":
      return { id: block.id, type: "callout", tone: block.type === "callout" ? block.tone : "info", text, ...extra };
    case "code":
      return { id: block.id, type: "code", language: block.type === "code" ? block.language : "plaintext", code: text, ...extra };
    case "math":
      return { id: block.id, type: "math", expression: text, display: true, ...extra };
    case "diagram":
      return { id: block.id, type: "diagram", source: text || "flowchart LR\n  A --> B", ...extra };
    default:
      return createDefaultBlock(targetType, { id: block.id });
  }
}

function cloneBlockWithFreshIds(block: DocBlock): DocBlock {
  const id = makeBlockId();
  const children = block.children?.map(cloneBlockWithFreshIds);
  if (block.type === "columns") {
    return {
      ...block,
      id,
      columns: block.columns.map((col) => ({ blocks: col.blocks.map(cloneBlockWithFreshIds) })),
      ...(children !== undefined ? { children } : {}),
    };
  }
  return {
    ...block,
    id,
    ...(children !== undefined ? { children } : {}),
  };
}

function mapColumnBlocks(columns: readonly DocColumn[], fn: (blocks: readonly DocBlock[]) => DocBlock[]): DocColumn[] {
  return columns.map((col) => ({ blocks: fn(col.blocks) }));
}

export function insertBlockAfter(blocks: readonly DocBlock[], afterId: string | undefined, newBlock: DocBlock): DocBlock[] {
  if (afterId === undefined) return [...blocks, newBlock];
  let inserted = false;
  const out: DocBlock[] = [];
  for (const b of blocks) {
    let next = b;
    if (!inserted) {
      if (b.children && b.children.length > 0) {
        const nextChildren = insertBlockAfterRec(b.children, afterId, newBlock);
        if (nextChildren.inserted) {
          inserted = true;
          next = { ...b, children: nextChildren.blocks };
        }
      }
      if (!inserted && b.type === "columns") {
        const cols: DocColumn[] = [];
        for (const col of b.columns) {
          if (!inserted) {
            const res = insertBlockAfterRec(col.blocks, afterId, newBlock);
            if (res.inserted) inserted = true;
            cols.push({ blocks: res.blocks });
          } else {
            cols.push(col);
          }
        }
        if (inserted) next = { ...b, columns: cols };
      }
    }
    out.push(next);
    if (!inserted && b.id === afterId) {
      out.push(newBlock);
      inserted = true;
    }
  }
  if (!inserted) out.push(newBlock);
  return out;
}

function insertBlockAfterRec(blocks: readonly DocBlock[], afterId: string, newBlock: DocBlock): { readonly blocks: DocBlock[]; readonly inserted: boolean } {
  let inserted = false;
  const out: DocBlock[] = [];
  for (const b of blocks) {
    let next = b;
    if (!inserted && b.children && b.children.length > 0) {
      const childRes = insertBlockAfterRec(b.children, afterId, newBlock);
      if (childRes.inserted) {
        inserted = true;
        next = { ...b, children: childRes.blocks };
      }
    }
    if (!inserted && b.type === "columns") {
      const cols: DocColumn[] = [];
      for (const col of b.columns) {
        if (!inserted) {
          const colRes = insertBlockAfterRec(col.blocks, afterId, newBlock);
          if (colRes.inserted) inserted = true;
          cols.push({ blocks: colRes.blocks });
        } else {
          cols.push(col);
        }
      }
      if (inserted) next = { ...b, columns: cols };
    }
    out.push(next);
    if (!inserted && b.id === afterId) {
      out.push(newBlock);
      inserted = true;
    }
  }
  return { blocks: out, inserted };
}

export function replaceBlockById(blocks: readonly DocBlock[], id: string, updater: (block: DocBlock) => DocBlock): DocBlock[] {
  return blocks.map((b) => {
    if (b.id === id) return updater(b);
    let next = b;
    if (next.children) {
      const updatedChildren = replaceBlockById(next.children, id, updater);
      if (updatedChildren !== next.children) {
        next = { ...next, children: updatedChildren };
      }
    }
    if (next.type === "columns") {
      next = { ...next, columns: mapColumnBlocks(next.columns, (colBlocks) => replaceBlockById(colBlocks, id, updater)) };
    }
    return next;
  });
}

export function deleteBlockById(blocks: readonly DocBlock[], id: string): DocBlock[] {
  const out: DocBlock[] = [];
  for (const b of blocks) {
    if (b.id === id) continue;
    let next = b;
    if (next.children) {
      next = { ...next, children: deleteBlockById(next.children, id) };
    }
    if (next.type === "columns") {
      next = { ...next, columns: mapColumnBlocks(next.columns, (colBlocks) => deleteBlockById(colBlocks, id)) };
    }
    out.push(next);
  }
  return out;
}

export function moveBlockById(blocks: readonly DocBlock[], id: string, direction: "up" | "down"): DocBlock[] {
  const idx = blocks.findIndex((b) => b.id === id);
  if (idx !== -1) {
    const target = direction === "up" ? idx - 1 : idx + 1;
    if (target < 0 || target >= blocks.length) return [...blocks];
    const next = [...blocks];
    const a = next[idx];
    const b = next[target];
    if (a !== undefined && b !== undefined) {
      next[idx] = b;
      next[target] = a;
    }
    return next;
  }
  return blocks.map((b) => {
    let next = b;
    if (next.children) {
      next = { ...next, children: moveBlockById(next.children, id, direction) };
    }
    if (next.type === "columns") {
      next = { ...next, columns: mapColumnBlocks(next.columns, (colBlocks) => moveBlockById(colBlocks, id, direction)) };
    }
    return next;
  });
}

export function duplicateBlockById(blocks: readonly DocBlock[], id: string): DocBlock[] {
  const out: DocBlock[] = [];
  for (const b of blocks) {
    if (b.id === id) {
      out.push(b, cloneBlockWithFreshIds(b));
      continue;
    }
    let next = b;
    if (next.children) {
      next = { ...next, children: duplicateBlockById(next.children, id) };
    }
    if (next.type === "columns") {
      next = { ...next, columns: mapColumnBlocks(next.columns, (colBlocks) => duplicateBlockById(colBlocks, id)) };
    }
    out.push(next);
  }
  return out;
}

export function appendChildToToggle(blocks: readonly DocBlock[], toggleId: string, child: DocBlock): DocBlock[] {
  return replaceBlockById(blocks, toggleId, (b) => ({
    ...b,
    collapsed: false,
    children: [...(b.children ?? []), child],
  }));
}

export function setColumnsCount(block: Extract<DocBlock, { type: "columns" }>, count: 2 | 3): Extract<DocBlock, { type: "columns" }> {
  const cols = [...block.columns];
  while (cols.length < count) {
    cols.push({ blocks: [{ id: makeBlockId("col"), type: "prose", text: "" }] });
  }
  if (cols.length > count) {
    const trimmed = cols.slice(0, count);
    const overflow = cols.slice(count).flatMap((c) => c.blocks);
    const last = trimmed[count - 1];
    if (last !== undefined && overflow.length > 0) {
      trimmed[count - 1] = { blocks: [...last.blocks, ...overflow] };
    }
    return { ...block, columns: trimmed };
  }
  return { ...block, columns: cols };
}

export type TableBlock = Extract<DocBlock, { type: "table" }>;

export function addTableRow(block: TableBlock): TableBlock {
  const emptyRow = block.headers.map(() => "");
  return { ...block, rows: [...block.rows, emptyRow] };
}

export function removeTableRow(block: TableBlock, rowIndex: number): TableBlock {
  if (block.rows.length <= 1) return block;
  return { ...block, rows: block.rows.filter((_, idx) => idx !== rowIndex) };
}

export function addTableColumn(block: TableBlock): TableBlock {
  const colNum = block.headers.length + 1;
  return {
    ...block,
    headers: [...block.headers, `Column ${colNum}`],
    rows: block.rows.map((row) => [...row, ""]),
    alignments: [...(block.alignments ?? block.headers.map(() => "left")), "left"],
  };
}

export function removeTableColumn(block: TableBlock, colIndex: number): TableBlock {
  if (block.headers.length <= 1) return block;
  return {
    ...block,
    headers: block.headers.filter((_, idx) => idx !== colIndex),
    rows: block.rows.map((row) => row.filter((_, idx) => idx !== colIndex)),
    alignments: block.alignments?.filter((_, idx) => idx !== colIndex),
  };
}

export function updateTableHeader(block: TableBlock, colIndex: number, value: string): TableBlock {
  return {
    ...block,
    headers: block.headers.map((h, idx) => (idx === colIndex ? value : h)),
  };
}

export function updateTableCell(block: TableBlock, rowIndex: number, colIndex: number, value: string): TableBlock {
  return {
    ...block,
    rows: block.rows.map((row, rIdx) => (rIdx === rowIndex ? row.map((cell, cIdx) => (cIdx === colIndex ? value : cell)) : row)),
  };
}

export function cycleTableAlignment(block: TableBlock, colIndex: number): TableBlock {
  const order: readonly TableAlignment[] = ["left", "center", "right"];
  const current = block.alignments?.[colIndex] ?? "left";
  const curIdx = order.findIndex((a) => a === current);
  const nextAlign = order[(curIdx + 1) % order.length] ?? "left";
  const base = block.headers.map((_, idx) => block.alignments?.[idx] ?? "left");
  base[colIndex] = nextAlign;
  return { ...block, alignments: base };
}

export interface TocEntry {
  readonly blockId: string;
  readonly level: number;
  readonly text: string;
}

export function extractTocEntries(blocks: readonly DocBlock[], maxLevel = 3): readonly TocEntry[] {
  const clampedMax = Math.max(1, Math.min(6, maxLevel));
  const out: TocEntry[] = [];
  const walk = (list: readonly DocBlock[]) => {
    for (const b of list) {
      if (b.type === "heading" && b.level <= clampedMax && b.text.trim() !== "") {
        out.push({ blockId: b.id, level: b.level, text: b.text.trim() });
      }
      if (b.type === "columns") {
        for (const col of b.columns) walk(col.blocks);
      }
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  return out;
}

export interface DocStats {
  readonly blockCount: number;
  readonly wordCount: number;
  readonly slideCount: number;
}

function countTextWords(text: string | undefined): number {
  if (!text) return 0;
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/u).length;
}

export function computeDocStats(blocks: readonly DocBlock[]): DocStats {
  let blockCount = 0;
  let wordCount = 0;
  let pageBreaks = 0;

  const walk = (list: readonly DocBlock[]) => {
    for (const b of list) {
      blockCount += 1;
      switch (b.type) {
        case "prose":
        case "heading":
        case "todo":
          wordCount += countTextWords(b.text);
          break;
        case "quote":
          wordCount += countTextWords(b.text) + countTextWords(b.attribution);
          break;
        case "toggle":
          wordCount += countTextWords(b.title) + countTextWords(b.text);
          break;
        case "callout":
          wordCount += countTextWords(b.title) + countTextWords(b.text);
          break;
        case "list":
          for (const item of b.items) wordCount += countTextWords(item);
          break;
        case "code":
          wordCount += countTextWords(b.code);
          break;
        case "table":
          for (const h of b.headers) wordCount += countTextWords(h);
          for (const row of b.rows) {
            for (const cell of row) wordCount += countTextWords(cell);
          }
          break;
        case "bookmark":
          wordCount += countTextWords(b.title) + countTextWords(b.description);
          break;
        case "math":
          wordCount += countTextWords(b.expression);
          break;
        case "pageBreak":
          pageBreaks += 1;
          break;
        case "columns":
          for (const col of b.columns) walk(col.blocks);
          break;
        case "divider":
        case "toc":
        case "kpi":
        case "chart":
        case "diagram":
        case "compare":
        case "media":
        case "preview":
        case "baseEmbed":
        case "issueCard":
        case "issueList":
          break;
      }
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);

  return { blockCount, wordCount, slideCount: pageBreaks + 1 };
}

/** Computes 1-based slide index after each `pageBreak` block in document order. */
export function computeSlideIndices(blocks: readonly DocBlock[]): ReadonlyMap<string, number> {
  const map = new Map<string, number>();
  let slide = 1;
  const walk = (list: readonly DocBlock[]) => {
    for (const b of list) {
      if (b.type === "pageBreak") {
        slide += 1;
        map.set(b.id, slide);
      }
      if (b.type === "columns") {
        for (const col of b.columns) walk(col.blocks);
      }
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  return map;
}

export function buildChartSpecJson(block: Extract<DocBlock, { type: "chart" }>, width = 640): string {
  const kind = block.kind === "line" || block.kind === "area" ? block.kind : "bar";
  return JSON.stringify({
    type: kind,
    width,
    height: 240,
    categories: block.labels,
    series: block.series,
    ...(kind === "line" ? { interpolation: "smooth", showPoints: true } : { cornerRadius: 4 }),
  });
}

export function resolveIssueRef(issues: readonly Issue[], idOrNumber: string): Issue | undefined {
  const clean = idOrNumber.trim().replace(/^#/u, "");
  if (!clean) return undefined;
  const direct = issues.find((i) => i.id === idOrNumber || i.id === clean);
  if (direct) return direct;
  if (/^\d+$/u.test(clean)) {
    const num = Number.parseInt(clean, 10);
    return issues.find((i) => i.number === num);
  }
  return undefined;
}

export function filterIssuesForList(
  issues: readonly Issue[],
  filter: { readonly repo?: string | undefined; readonly status?: string | undefined; readonly tag?: string | undefined; readonly limit?: number | undefined },
): readonly Issue[] {
  const repo = filter.repo?.trim() ?? "";
  const status = filter.status?.trim() ?? "";
  const tag = filter.tag?.trim() ?? "";
  const limit = filter.limit !== undefined && filter.limit > 0 ? filter.limit : 10;
  return issues
    .filter((issue) => {
      if (repo && issue.repo !== repo) return false;
      if (status && issue.status !== status) return false;
      if (tag && !(issue.tags ?? []).includes(tag)) return false;
      return true;
    })
    .slice(0, limit);
}

export const CALLOUT_TONES: readonly CalloutTone[] = ["info", "tip", "warn", "danger", "note"];

function normalizeCalloutTone(tone: string): CalloutTone {
  switch (tone) {
    case "tip":
    case "ok":
      return "tip";
    case "warn":
      return "warn";
    case "danger":
    case "bad":
      return "danger";
    case "note":
      return "note";
    default:
      return "info";
  }
}

export interface CalloutVisual {
  readonly tone: CalloutTone;
  readonly label: string;
  readonly icon: IconName;
  readonly iconTone: string;
  readonly bgClass: string;
  readonly textClass: string;
  readonly mixToken?: string;
}

export function calloutVisualOf(rawTone: string): CalloutVisual {
  const tone = normalizeCalloutTone(rawTone);
  switch (tone) {
    case "tip":
      return { tone, label: t("web.note.doc.calloutTones.tip"), icon: "check", iconTone: "ok-ink", bgClass: "bg-ok-soft", textClass: "text-ok-ink" };
    case "warn":
      return { tone, label: t("web.note.doc.calloutTones.warn"), icon: "warn", iconTone: "warn-ink", bgClass: "bg-warn-soft", textClass: "text-warn-ink" };
    case "danger":
      return { tone, label: t("web.note.doc.calloutTones.danger"), icon: "cross", iconTone: "berry", bgClass: "bg-bad-soft", textClass: "text-berry" };
    case "note":
      return { tone, label: t("web.note.doc.calloutTones.note"), icon: "notes", iconTone: "muted", bgClass: "bg-side", textClass: "text-ink" };
    case "info":
      return { tone, label: t("web.note.doc.calloutTones.info"), icon: "info", iconTone: "water", bgClass: "", textClass: "text-ink", mixToken: "water" };
  }
}

export function calloutToneLabel(rawTone: CalloutTone): string {
  switch (rawTone) {
    case "tip":
      return t("web.note.doc.calloutTones.tip");
    case "warn":
      return t("web.note.doc.calloutTones.warn");
    case "danger":
      return t("web.note.doc.calloutTones.danger");
    case "note":
      return t("web.note.doc.calloutTones.note");
    case "info":
      return t("web.note.doc.calloutTones.info");
  }
}

export function isTurnIntoActive(block: DocBlock, opt: TurnIntoOption): boolean {
  if (block.type !== opt.type) return false;
  if (block.type === "heading") return block.level === opt.headingLevel;
  if (block.type === "list") return block.ordered === (opt.listOrdered === true);
  return true;
}

export function wrapInlineMarkdown(text: string, marker: "**" | "*" | "`" | "~~"): string {
  const trimmed = text.trimEnd();
  const suffix = text.slice(trimmed.length);
  if (!trimmed) return `${marker}${marker}`;
  const m = /^(.*?)(\S+)$/su.exec(trimmed);
  if (!m) return `${text}${marker}${marker}`;
  const head = m[1] ?? "";
  const tail = m[2] ?? "";
  if (tail.startsWith(marker) && tail.endsWith(marker) && tail.length >= marker.length * 2) {
    return `${head}${tail.slice(marker.length, tail.length - marker.length)}${suffix}`;
  }
  return `${head}${marker}${tail}${marker}${suffix}`;
}

export function neighborBlockId(blocks: readonly DocBlock[], currentId: string, dir: "prev" | "next"): string | undefined {
  const flat: string[] = [];
  const walk = (list: readonly DocBlock[]) => {
    for (const b of list) {
      flat.push(b.id);
      if (b.type === "columns") {
        for (const col of b.columns) walk(col.blocks);
      }
      if (b.children) walk(b.children);
    }
  };
  walk(blocks);
  const idx = flat.indexOf(currentId);
  if (idx === -1) return undefined;
  return dir === "prev" ? flat[idx - 1] : flat[idx + 1];
}

export function updateKpiItem(items: readonly DocKpiItem[], idx: number, patch: Partial<DocKpiItem>): DocKpiItem[] {
  return items.map((item, i) => (i === idx ? { ...item, ...patch } : item));
}
