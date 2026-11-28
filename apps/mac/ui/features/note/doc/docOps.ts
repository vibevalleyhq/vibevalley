import { t } from "@vibevalley/i18n";
import type { DocBlock, DocColumn, DocKpiItem, Issue, IssueStatus } from "@vibevalley/protocol";
import { issueId, noteId } from "@vibevalley/protocol/schema";

import type { IconName } from "../../../design/icons";
import type { DotTone } from "../../../design/Tag";
import { matches } from "../../../infra/base/search";
import { isValidHashIssueBoundary } from "./richInlineCodec";

export const ISSUE_STATUS_DOT_TONE: Record<IssueStatus, DotTone> = {
  backlog: "faint",
  todo: "muted",
  in_progress: "water",
  in_review: "wheat",
  done: "leaf",
  canceled: "faint",
};

export type BlockType = DocBlock["type"];
type SlashCategory = "basic" | "structure" | "data";
type CalloutTone = "info" | "tip" | "warn" | "danger" | "note";
type TableAlignment = "left" | "center" | "right" | "";

type SlashI18nId =
  | "prose"
  | "heading1"
  | "heading2"
  | "heading3"
  | "listBullet"
  | "listOrdered"
  | "todo"
  | "quote"
  | "divider"
  | "toggle"
  | "callout"
  | "code"
  | "table"
  | "bookmark"
  | "toc"
  | "math"
  | "columns"
  | "pageBreak"
  | "kpi"
  | "chart"
  | "diagram"
  | "compare"
  | "media"
  | "preview"
  | "baseEmbed"
  | "issueCard"
  | "issueList";

export interface SlashCommandItem {
  readonly key: string;
  readonly type: BlockType;
  readonly headingLevel?: 1 | 2 | 3;
  readonly listOrdered?: boolean;
  readonly category: SlashCategory;
  readonly labelKey: `web.note.doc.slash.${SlashI18nId}.label`;
  readonly descKey: `web.note.doc.slash.${SlashI18nId}.desc`;
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
    labelKey: "web.note.doc.slash.prose.label",
    descKey: "web.note.doc.slash.prose.desc",
    icon: "edit",
    keywords: ["paragraph", "text", "prose", "p", "wenben", "duanluo"],
  },
  {
    key: "heading-1",
    type: "heading",
    headingLevel: 1,
    category: "basic",
    labelKey: "web.note.doc.slash.heading1.label",
    descKey: "web.note.doc.slash.heading1.desc",
    shortcut: "#",
    icon: "notes",
    keywords: ["h1", "heading", "title", "biaoti"],
  },
  {
    key: "heading-2",
    type: "heading",
    headingLevel: 2,
    category: "basic",
    labelKey: "web.note.doc.slash.heading2.label",
    descKey: "web.note.doc.slash.heading2.desc",
    shortcut: "##",
    icon: "notes",
    keywords: ["h2", "heading", "subtitle", "erjibiaoti"],
  },
  {
    key: "heading-3",
    type: "heading",
    headingLevel: 3,
    category: "basic",
    labelKey: "web.note.doc.slash.heading3.label",
    descKey: "web.note.doc.slash.heading3.desc",
    shortcut: "###",
    icon: "notes",
    keywords: ["h3", "heading", "sanjibiaoti"],
  },
  {
    key: "list-bullet",
    type: "list",
    listOrdered: false,
    category: "basic",
    labelKey: "web.note.doc.slash.listBullet.label",
    descKey: "web.note.doc.slash.listBullet.desc",
    shortcut: "-",
    icon: "log",
    keywords: ["ul", "bullet", "list", "liebiao"],
  },
  {
    key: "list-ordered",
    type: "list",
    listOrdered: true,
    category: "basic",
    labelKey: "web.note.doc.slash.listOrdered.label",
    descKey: "web.note.doc.slash.listOrdered.desc",
    shortcut: "1.",
    icon: "log",
    keywords: ["ol", "ordered", "numbered", "list", "youxuliebiao"],
  },
  {
    key: "todo",
    type: "todo",
    category: "basic",
    labelKey: "web.note.doc.slash.todo.label",
    descKey: "web.note.doc.slash.todo.desc",
    shortcut: "[]",
    icon: "ticked",
    keywords: ["todo", "task", "checkbox", "daiban"],
  },
  {
    key: "quote",
    type: "quote",
    category: "basic",
    labelKey: "web.note.doc.slash.quote.label",
    descKey: "web.note.doc.slash.quote.desc",
    shortcut: ">",
    icon: "reply",
    keywords: ["quote", "blockquote", "citation", "yinyong"],
  },
  {
    key: "divider",
    type: "divider",
    category: "basic",
    labelKey: "web.note.doc.slash.divider.label",
    descKey: "web.note.doc.slash.divider.desc",
    shortcut: "---",
    icon: "minus",
    keywords: ["divider", "hr", "line", "separator", "fengexian"],
  },
  {
    key: "toggle",
    type: "toggle",
    category: "structure",
    labelKey: "web.note.doc.slash.toggle.label",
    descKey: "web.note.doc.slash.toggle.desc",
    icon: "expand",
    keywords: ["toggle", "collapse", "details", "zhedie"],
  },
  {
    key: "callout",
    type: "callout",
    category: "structure",
    labelKey: "web.note.doc.slash.callout.label",
    descKey: "web.note.doc.slash.callout.desc",
    icon: "info",
    keywords: ["callout", "notice", "alert", "tip", "tishi"],
  },
  {
    key: "code",
    type: "code",
    category: "structure",
    labelKey: "web.note.doc.slash.code.label",
    descKey: "web.note.doc.slash.code.desc",
    shortcut: "```",
    icon: "terminal",
    keywords: ["code", "fence", "snippet", "daima"],
  },
  {
    key: "table",
    type: "table",
    category: "structure",
    labelKey: "web.note.doc.slash.table.label",
    descKey: "web.note.doc.slash.table.desc",
    icon: "catalog",
    keywords: ["table", "grid", "biaoge"],
  },
  {
    key: "bookmark",
    type: "bookmark",
    category: "structure",
    labelKey: "web.note.doc.slash.bookmark.label",
    descKey: "web.note.doc.slash.bookmark.desc",
    icon: "link",
    keywords: ["bookmark", "url", "link", "shuqian"],
  },
  {
    key: "toc",
    type: "toc",
    category: "structure",
    labelKey: "web.note.doc.slash.toc.label",
    descKey: "web.note.doc.slash.toc.desc",
    icon: "sidebarRight",
    keywords: ["toc", "outline", "contents", "mulu"],
  },
  {
    key: "math",
    type: "math",
    category: "structure",
    labelKey: "web.note.doc.slash.math.label",
    descKey: "web.note.doc.slash.math.desc",
    shortcut: "$$",
    icon: "understand",
    keywords: ["math", "latex", "formula", "equation", "gongshi"],
  },
  {
    key: "columns",
    type: "columns",
    category: "structure",
    labelKey: "web.note.doc.slash.columns.label",
    descKey: "web.note.doc.slash.columns.desc",
    icon: "sidebar",
    keywords: ["columns", "grid", "layout", "fenlan"],
  },
  {
    key: "pageBreak",
    type: "pageBreak",
    category: "structure",
    labelKey: "web.note.doc.slash.pageBreak.label",
    descKey: "web.note.doc.slash.pageBreak.desc",
    icon: "present",
    keywords: ["pagebreak", "slide", "presenter", "fenye"],
  },
  {
    key: "kpi",
    type: "kpi",
    category: "data",
    labelKey: "web.note.doc.slash.kpi.label",
    descKey: "web.note.doc.slash.kpi.desc",
    icon: "spend",
    keywords: ["kpi", "metric", "stat", "zhibiao"],
  },
  {
    key: "chart",
    type: "chart",
    category: "data",
    labelKey: "web.note.doc.slash.chart.label",
    descKey: "web.note.doc.slash.chart.desc",
    icon: "generate",
    keywords: ["chart", "graph", "bar", "line", "tubiao"],
  },
  {
    key: "diagram",
    type: "diagram",
    category: "data",
    labelKey: "web.note.doc.slash.diagram.label",
    descKey: "web.note.doc.slash.diagram.desc",
    icon: "branch",
    keywords: ["diagram", "mermaid", "flowchart", "jiagoutu"],
  },
  {
    key: "compare",
    type: "compare",
    category: "data",
    labelKey: "web.note.doc.slash.compare.label",
    descKey: "web.note.doc.slash.compare.desc",
    icon: "diff",
    keywords: ["compare", "diff", "before", "after", "duibi"],
  },
  {
    key: "media",
    type: "media",
    category: "data",
    labelKey: "web.note.doc.slash.media.label",
    descKey: "web.note.doc.slash.media.desc",
    icon: "image",
    keywords: ["media", "image", "audio", "video", "tupian"],
  },
  {
    key: "preview",
    type: "preview",
    category: "data",
    labelKey: "web.note.doc.slash.preview.label",
    descKey: "web.note.doc.slash.preview.desc",
    icon: "web",
    keywords: ["preview", "html", "prototype", "yulan"],
  },
  {
    key: "baseEmbed",
    type: "baseEmbed",
    category: "data",
    labelKey: "web.note.doc.slash.baseEmbed.label",
    descKey: "web.note.doc.slash.baseEmbed.desc",
    icon: "folder",
    keywords: ["base", "embed", "database", "duoweiku"],
  },
  {
    key: "issueCard",
    type: "issueCard",
    category: "data",
    labelKey: "web.note.doc.slash.issueCard.label",
    descKey: "web.note.doc.slash.issueCard.desc",
    icon: "issues",
    keywords: ["issue", "card", "gongdan"],
  },
  {
    key: "issueList",
    type: "issueList",
    category: "data",
    labelKey: "web.note.doc.slash.issueList.label",
    descKey: "web.note.doc.slash.issueList.desc",
    icon: "filter",
    keywords: ["issue", "list", "query", "gongdanliebiao"],
  },
];

const SLASH_COMMAND_BY_KEY = new Map(SLASH_COMMANDS.map((item) => [item.key, item]));

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
  const item = SLASH_COMMAND_BY_KEY.get(key);
  return item ? t(item.labelKey) : key;
}

export function slashCommandDesc(key: string): string {
  const item = SLASH_COMMAND_BY_KEY.get(key);
  return item ? t(item.descKey) : "";
}

export function filterSlashCommands(query: string): readonly SlashCommandItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_COMMANDS;
  return SLASH_COMMANDS.filter((item) => matches(q, [t(item.labelKey), t(item.descKey), item.type, item.shortcut, ...item.keywords]));
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

interface MarkdownRuleResult {
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

interface SlashTrigger {
  readonly query: string;
  readonly triggerIndex: number;
}

export function detectSlashTrigger(text: string, caretOffset?: number): SlashTrigger | undefined {
  const head = caretOffset !== undefined ? text.slice(0, Math.max(0, Math.min(text.length, caretOffset))) : text;
  const m = /(?:^|\s)\/([^\s/]*)$/u.exec(head);
  if (!m) return undefined;
  const full = m[0];
  const slashOffset = full.indexOf("/");
  return {
    query: m[1] ?? "",
    triggerIndex: m.index + slashOffset,
  };
}

export function stripSlashTrigger(text: string, triggerIndex: number, endIndex?: number): string {
  const before = text.slice(0, triggerIndex);
  if (endIndex === undefined || endIndex >= text.length) {
    return before.trimEnd();
  }
  const after = text.slice(Math.max(triggerIndex, endIndex));
  if (after.length === 0) return before.trimEnd();
  if (before.endsWith(" ") && after.startsWith(" ")) {
    return `${before.slice(0, -1)}${after}`;
  }
  return `${before}${after}`.trim();
}

export type WikilinkMode = "wikilink" | "embed" | "issue";

interface WikilinkTrigger {
  readonly mode: WikilinkMode;
  readonly query: string;
  readonly startIndex: number;
}

export function detectWikilinkTrigger(text: string, caretOffset?: number): WikilinkTrigger | undefined {
  const head = caretOffset !== undefined ? text.slice(0, Math.max(0, Math.min(text.length, caretOffset))) : text;
  const embed = /!\[\[([^[\]]*)$/u.exec(head);
  if (embed) {
    return { mode: "embed", query: embed[1] ?? "", startIndex: embed.index };
  }
  const wiki = /\[\[([^[\]]*)$/u.exec(head);
  if (wiki) {
    return { mode: "wikilink", query: wiki[1] ?? "", startIndex: wiki.index };
  }
  const issue = /(?:^|[\s([,:;])#([a-zA-Z0-9_-]*)$/u.exec(head);
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

function applyWikilinkReplacementWithCaret(
  text: string,
  startIndex: number,
  token: string,
  endIndex?: number,
): { readonly text: string; readonly caret: number } {
  const before = text.slice(0, startIndex);
  const after = endIndex !== undefined ? text.slice(Math.max(startIndex, endIndex)) : "";
  const needsLeadingSpace = before.length > 0 && !/\s$/u.test(before) && !before.endsWith("(") && !before.endsWith("[");
  const needsTrailingSpace = after.length === 0 || (!/^\s/u.test(after) && !/^[.,!?;:)\]，。、；：！？）】」』》]/u.test(after));
  const inserted = `${needsLeadingSpace ? " " : ""}${token}${needsTrailingSpace ? " " : ""}`;
  return {
    text: `${before}${inserted}${after}`,
    caret: before.length + inserted.length,
  };
}

export function applyWikilinkReplacement(text: string, startIndex: number, token: string, endIndex?: number): string {
  return applyWikilinkReplacementWithCaret(text, startIndex, token, endIndex).text;
}

export type InlineSegment =
  | { readonly kind: "text"; readonly value: string }
  | { readonly kind: "note"; readonly id: string; readonly label: string; readonly embed: boolean }
  | { readonly kind: "issue"; readonly id: string; readonly label: string; readonly embed: boolean }
  | { readonly kind: "issueNumber"; readonly number: number };

export type InlineStyleKind = "plain" | "bold" | "italic" | "code" | "strike";

interface InlineStyleRun {
  readonly kind: InlineStyleKind;
  readonly value: string;
}

const INLINE_TOKEN_RE = /(!?\[\[(?:(note|issue):([^\]|]+?)|#(\d+))(?:\|([^\]]*))?\]\])|((?:^|[\s([,:;/，。、；：！？（【「『《])#(\d+)(?![a-zA-Z0-9_]))/gu;
const INLINE_MARKDOWN_RE = /(\*\*([^*\n]+?)\*\*)|(`([^`\n]+?)`)|(~~([^~\n]+?)~~)|(\*([^*\n]+?)\*)/gu;

export function hasInlineRichTokens(text: string): boolean {
  if (!text) return false;
  if (text.includes("[[")) return true;
  if (/(?:^|[\s([,:;，。、；：！？（【「『《])#\d+/u.test(text) || /#\d+\/#\d+/u.test(text)) return true;
  return /\*\*[^*\n]+?\*\*|`[^`\n]+?`|~~[^~\n]+?~~/u.test(text);
}

export function parseInlineMarkdownRuns(text: string): readonly InlineStyleRun[] {
  if (!text) return [];
  const out: InlineStyleRun[] = [];
  let cursor = 0;
  INLINE_MARKDOWN_RE.lastIndex = 0;
  for (;;) {
    const m = INLINE_MARKDOWN_RE.exec(text);
    if (!m) break;
    if (m.index > cursor) {
      out.push({ kind: "plain", value: text.slice(cursor, m.index) });
    }
    if (m[2] !== undefined) {
      out.push({ kind: "bold", value: m[2] });
    } else if (m[4] !== undefined) {
      out.push({ kind: "code", value: m[4] });
    } else if (m[6] !== undefined) {
      out.push({ kind: "strike", value: m[6] });
    } else if (m[8] !== undefined) {
      out.push({ kind: "italic", value: m[8] });
    }
    cursor = m.index + m[0].length;
  }
  if (cursor < text.length) {
    out.push({ kind: "plain", value: text.slice(cursor) });
  }
  return out;
}

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
      const alias = m[5]?.trim() ?? "";
      if (m[4] !== undefined) {
        out.push({ kind: "issueNumber", number: Number.parseInt(m[4], 10) });
      } else {
        const kind = m[2] === "note" ? "note" : "issue";
        const rawId = (m[3] ?? "").trim();
        const id = kind === "issue" ? rawId.replace(/^#/u, "") : rawId;
        out.push({
          kind,
          id,
          label: alias || (kind === "issue" ? `#${id}` : id),
          embed,
        });
      }
      cursor = m.index + m[1].length;
    } else if (m[6] !== undefined && m[7] !== undefined) {
      const hashPos = m[6].lastIndexOf("#");
      const tokenStart = m.index + hashPos;
      if (!isValidHashIssueBoundary(text.slice(0, tokenStart), true)) {
        continue;
      }
      if (tokenStart > cursor) {
        out.push({ kind: "text", value: text.slice(cursor, tokenStart) });
      }
      const num = Number.parseInt(m[7], 10);
      out.push({ kind: "issueNumber", number: num });
      cursor = tokenStart + 1 + m[7].length;
    }
  }
  if (cursor < text.length) {
    out.push({ kind: "text", value: text.slice(cursor) });
  }
  return out;
}

interface TurnIntoOption {
  readonly key: string;
  readonly type: BlockType;
  readonly headingLevel?: 1 | 2 | 3;
  readonly listOrdered?: boolean;
  readonly icon: IconName;
}

const TURN_INTO_KEYS: readonly string[] = [
  "prose",
  "heading-1",
  "heading-2",
  "heading-3",
  "list-bullet",
  "list-ordered",
  "todo",
  "quote",
  "toggle",
  "callout",
  "code",
  "math",
];

export const TURN_INTO_OPTIONS: readonly TurnIntoOption[] = TURN_INTO_KEYS.flatMap((key) => {
  const item = SLASH_COMMAND_BY_KEY.get(key);
  if (!item) return [];
  return [
    {
      key: item.key,
      type: item.type,
      ...(item.headingLevel !== undefined ? { headingLevel: item.headingLevel } : {}),
      ...(item.listOrdered !== undefined ? { listOrdered: item.listOrdered } : {}),
      icon: item.icon,
    },
  ];
});

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
  const res = insertBlockAfterRec(blocks, afterId, newBlock);
  return res.inserted ? res.blocks : [...res.blocks, newBlock];
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

type TableBlock = Extract<DocBlock, { type: "table" }>;

export function addTableRow(block: TableBlock): TableBlock {
  const emptyRow = block.headers.map(() => "");
  return { ...block, rows: [...block.rows, emptyRow] };
}

export function insertTableRowAt(block: TableBlock, index: number): TableBlock {
  const clamped = Math.max(0, Math.min(block.rows.length, index));
  const emptyRow = block.headers.map(() => "");
  return { ...block, rows: [...block.rows.slice(0, clamped), emptyRow, ...block.rows.slice(clamped)] };
}

export function moveTableRow(block: TableBlock, fromIndex: number, toIndex: number): TableBlock {
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= block.rows.length || toIndex >= block.rows.length) {
    return block;
  }
  const next = [...block.rows];
  const [moved] = next.splice(fromIndex, 1);
  if (moved === undefined) return block;
  next.splice(toIndex, 0, moved);
  return { ...block, rows: next };
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

export function insertTableColumnAt(block: TableBlock, index: number): TableBlock {
  const clamped = Math.max(0, Math.min(block.headers.length, index));
  const colNum = block.headers.length + 1;
  const baseAligns = block.headers.map((_, idx) => block.alignments?.[idx] ?? "left");
  return {
    ...block,
    headers: [...block.headers.slice(0, clamped), `Column ${colNum}`, ...block.headers.slice(clamped)],
    rows: block.rows.map((row) => [...row.slice(0, clamped), "", ...row.slice(clamped)]),
    alignments: [...baseAligns.slice(0, clamped), "left", ...baseAligns.slice(clamped)],
  };
}

export function moveTableColumn(block: TableBlock, fromIndex: number, toIndex: number): TableBlock {
  const count = block.headers.length;
  if (fromIndex === toIndex || fromIndex < 0 || toIndex < 0 || fromIndex >= count || toIndex >= count) {
    return block;
  }
  const reorder = <T>(arr: readonly T[]): T[] => {
    const next = [...arr];
    const [moved] = next.splice(fromIndex, 1);
    if (moved === undefined) return [...arr];
    next.splice(toIndex, 0, moved);
    return next;
  };
  const baseAligns = block.headers.map((_, idx) => block.alignments?.[idx] ?? "left");
  return {
    ...block,
    headers: reorder(block.headers),
    rows: block.rows.map((row) => reorder(row)),
    alignments: reorder(baseAligns),
  };
}

export interface TableCellNavTarget {
  readonly row: number;
  readonly col: number;
  readonly addRow?: boolean;
}

/** Computes next table cell target for Tab / Shift+Tab / Enter navigation (`row === -1` denotes header row). */
export function nextTableCellTarget(
  rowCount: number,
  colCount: number,
  row: number,
  col: number,
  dir: "next" | "prev" | "down" | "up",
): TableCellNavTarget | undefined {
  if (colCount <= 0 || rowCount <= 0) return undefined;
  if (dir === "next") {
    if (col + 1 < colCount) return { row, col: col + 1 };
    if (row + 1 < rowCount) return { row: row + 1, col: 0 };
    return { row: rowCount, col: 0, addRow: true };
  }
  if (dir === "prev") {
    if (col - 1 >= 0) return { row, col: col - 1 };
    if (row - 1 >= 0) return { row: row - 1, col: colCount - 1 };
    return undefined;
  }
  if (dir === "down") {
    if (row + 1 < rowCount) return { row: row + 1, col };
    return { row: rowCount, col, addRow: true };
  }
  if (row - 1 >= 0) return { row: row - 1, col };
  return undefined;
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

interface TocEntry {
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

interface DocStats {
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
  const match = /^(?:i|issue[-_:]?)?(\d+)$/iu.exec(clean);
  if (match?.[1]) {
    const num = Number.parseInt(match[1], 10);
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

interface CalloutVisual {
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
  return calloutVisualOf(rawTone).label;
}

export function isTurnIntoActive(block: DocBlock, opt: TurnIntoOption): boolean {
  if (block.type !== opt.type) return false;
  if (block.type === "heading") return block.level === opt.headingLevel;
  if (block.type === "list") return block.ordered === (opt.listOrdered === true);
  return true;
}

export type InlineMarkdownMarker = "**" | "*" | "`" | "~~";

interface MarkdownWrapResult {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

export function wrapInlineMarkdownSelection(text: string, marker: InlineMarkdownMarker, rawStart: number, rawEnd = rawStart): MarkdownWrapResult {
  const mLen = marker.length;
  const a = Math.max(0, Math.min(text.length, rawStart));
  const b = Math.max(0, Math.min(text.length, rawEnd));
  const selStart = Math.min(a, b);
  const selEnd = Math.max(a, b);

  if (selEnd > selStart) {
    const selected = text.slice(selStart, selEnd);
    if (selStart >= mLen && selEnd + mLen <= text.length && text.slice(selStart - mLen, selStart) === marker && text.slice(selEnd, selEnd + mLen) === marker) {
      return {
        text: `${text.slice(0, selStart - mLen)}${selected}${text.slice(selEnd + mLen)}`,
        start: selStart - mLen,
        end: selEnd - mLen,
      };
    }
    if (selected.startsWith(marker) && selected.endsWith(marker) && selected.length >= mLen * 2) {
      const inner = selected.slice(mLen, selected.length - mLen);
      return {
        text: `${text.slice(0, selStart)}${inner}${text.slice(selEnd)}`,
        start: selStart,
        end: selStart + inner.length,
      };
    }
    return {
      text: `${text.slice(0, selStart)}${marker}${selected}${marker}${text.slice(selEnd)}`,
      start: selStart + mLen,
      end: selEnd + mLen,
    };
  }

  let wStart = selStart;
  while (wStart > 0 && !/\s/u.test(text[wStart - 1] ?? "")) {
    wStart -= 1;
  }
  let wEnd = selStart;
  while (wEnd < text.length && !/\s/u.test(text[wEnd] ?? "")) {
    wEnd += 1;
  }

  if (wStart === wEnd) {
    return {
      text: `${text.slice(0, selStart)}${marker}${marker}${text.slice(selStart)}`,
      start: selStart + mLen,
      end: selStart + mLen,
    };
  }

  const word = text.slice(wStart, wEnd);
  const rel = selStart - wStart;
  if (word.startsWith(marker) && word.endsWith(marker) && word.length >= mLen * 2) {
    const inner = word.slice(mLen, word.length - mLen);
    const nextCaret = wStart + Math.max(0, Math.min(inner.length, rel - mLen));
    return {
      text: `${text.slice(0, wStart)}${inner}${text.slice(wEnd)}`,
      start: nextCaret,
      end: nextCaret,
    };
  }
  const nextCaret = wStart + mLen + rel;
  return {
    text: `${text.slice(0, wStart)}${marker}${word}${marker}${text.slice(wEnd)}`,
    start: nextCaret,
    end: nextCaret,
  };
}

export function wrapInlineMarkdown(text: string, marker: InlineMarkdownMarker): string {
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

export interface BlockFocusTarget {
  readonly blockId: string;
  readonly caret?: "start" | "end" | number | undefined;
  readonly itemIndex?: number | undefined;
}

export function isCaretOnFirstLine(text: string, caret: number): boolean {
  const clamped = Math.max(0, Math.min(text.length, caret));
  return !text.slice(0, clamped).includes("\n");
}

export function isCaretOnLastLine(text: string, caret: number): boolean {
  const clamped = Math.max(0, Math.min(text.length, caret));
  return !text.slice(clamped).includes("\n");
}

function estimateCharAdvancePx(ch: string): number {
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 0x2e80) return 14;
  return 7.6;
}

/**
 * Estimates a UTF-16 caret offset in `text` when pressing an unfocused `<InlineRichText>` view.
 * Accounts for `[[note:...]]` / `[[issue:...]]` pills whose raw syntax is wider than their rendered pill.
 */
export function estimateInlineRichTextOffset(
  text: string,
  relX: number,
  relY: number,
  contentWidth: number,
  notesById?: ReadonlyMap<string, string>,
  lineHeight = 24,
): number {
  if (!text) return 0;
  const maxWidth = Math.max(120, contentWidth - 8);
  const targetX = Math.max(0, relX - 4);
  const targetLine = Math.max(0, Math.floor(Math.max(0, relY) / Math.max(12, lineHeight)));

  interface VisualAtom {
    readonly rawStart: number;
    readonly rawEnd: number;
    readonly widthPx: number;
    readonly isNewline: boolean;
  }

  const atoms: VisualAtom[] = [];
  let cursor = 0;
  INLINE_TOKEN_RE.lastIndex = 0;
  const pushPlainRange = (start: number, end: number) => {
    for (let i = start; i < end; i++) {
      const ch = text[i] ?? " ";
      if (ch === "\n") {
        atoms.push({ rawStart: i, rawEnd: i + 1, widthPx: 0, isNewline: true });
      } else {
        atoms.push({ rawStart: i, rawEnd: i + 1, widthPx: estimateCharAdvancePx(ch), isNewline: false });
      }
    }
  };

  for (;;) {
    const m = INLINE_TOKEN_RE.exec(text);
    if (!m) break;
    if (m[1] !== undefined) {
      if (m.index > cursor) pushPlainRange(cursor, m.index);
      const kind = m[2] === "note" ? "note" : "issue";
      const rawId = (m[3] ?? "").trim();
      const alias = m[4]?.trim() ?? "";
      const displayLabel = alias || (kind === "note" ? (notesById?.get(rawId) ?? rawId) : rawId);
      let pillTextWidth = 24;
      for (const ch of displayLabel) pillTextWidth += estimateCharAdvancePx(ch) * 0.88;
      atoms.push({
        rawStart: m.index,
        rawEnd: m.index + m[1].length,
        widthPx: pillTextWidth,
        isNewline: false,
      });
      cursor = m.index + m[1].length;
    } else if (m[5] !== undefined && m[6] !== undefined) {
      const hashOffset = m[5].lastIndexOf("#");
      const tokenStart = m.index + hashOffset;
      if (tokenStart > cursor) pushPlainRange(cursor, tokenStart);
      const tokenEnd = m.index + m[5].length;
      const pillWidth = 22 + (m[6].length + 1) * 7.2;
      atoms.push({ rawStart: tokenStart, rawEnd: tokenEnd, widthPx: pillWidth, isNewline: false });
      cursor = tokenEnd;
    }
  }
  if (cursor < text.length) pushPlainRange(cursor, text.length);

  const lines: VisualAtom[][] = [[]];
  let lineWidth = 0;
  for (const atom of atoms) {
    if (atom.isNewline) {
      lines.push([]);
      lineWidth = 0;
      continue;
    }
    const currentLine = lines[lines.length - 1];
    if (currentLine.length > 0 && lineWidth + atom.widthPx > maxWidth) {
      lines.push([atom]);
      lineWidth = atom.widthPx;
    } else {
      currentLine.push(atom);
      lineWidth += atom.widthPx;
    }
  }

  const chosenIdx = Math.min(lines.length - 1, targetLine);
  const chosenLine = lines[chosenIdx] ?? [];
  if (chosenLine.length === 0) {
    const prevLine = chosenIdx > 0 ? lines[chosenIdx - 1] : undefined;
    return prevLine && prevLine.length > 0 ? prevLine[prevLine.length - 1].rawEnd : 0;
  }

  let xAcc = 0;
  for (const atom of chosenLine) {
    const mid = xAcc + atom.widthPx / 2;
    if (targetX <= mid) return atom.rawStart;
    xAcc += atom.widthPx;
  }
  return chosenLine[chosenLine.length - 1].rawEnd;
}

function splitBlocksInList(
  blocks: readonly DocBlock[],
  blockId: string,
  selStart: number,
  selEnd: number,
  newId: string,
): { readonly blocks: DocBlock[]; readonly focus?: BlockFocusTarget | undefined } {
  const out: DocBlock[] = [];
  let focus: BlockFocusTarget | undefined;

  for (const b of blocks) {
    if (focus === undefined && b.id === blockId) {
      if (b.type === "prose" || b.type === "heading" || b.type === "todo") {
        const s = Math.max(0, Math.min(b.text.length, Math.min(selStart, selEnd)));
        const e = Math.max(0, Math.min(b.text.length, Math.max(selStart, selEnd)));
        const before = b.text.slice(0, s);
        const after = b.text.slice(e);

        if (b.type === "todo" && b.text === "") {
          out.push({ id: b.id, type: "prose", text: "" });
          focus = { blockId: b.id, caret: 0 };
          continue;
        }
        if (b.type === "heading" && s === 0 && b.text.length > 0) {
          out.push({ id: b.id, type: "prose", text: "" }, { ...b, id: newId, text: after });
          focus = { blockId: newId, caret: 0 };
          continue;
        }
        if (b.type === "heading") {
          out.push({ ...b, text: before }, { id: newId, type: "prose", text: after });
          focus = { blockId: newId, caret: 0 };
          continue;
        }
        if (b.type === "todo") {
          out.push({ ...b, text: before }, { id: newId, type: "todo", checked: false, text: after });
          focus = { blockId: newId, caret: 0 };
          continue;
        }
        out.push({ ...b, text: before }, { id: newId, type: "prose", text: after });
        focus = { blockId: newId, caret: 0 };
        continue;
      }
    }

    let next = b;
    if (focus === undefined && next.children && next.children.length > 0) {
      const childRes = splitBlocksInList(next.children, blockId, selStart, selEnd, newId);
      if (childRes.focus !== undefined) {
        focus = childRes.focus;
        next = { ...next, children: childRes.blocks };
      }
    }
    if (focus === undefined && next.type === "columns") {
      const cols: DocColumn[] = [];
      for (const col of next.columns) {
        if (focus === undefined) {
          const colRes = splitBlocksInList(col.blocks, blockId, selStart, selEnd, newId);
          if (colRes.focus !== undefined) focus = colRes.focus;
          cols.push({ blocks: colRes.blocks });
        } else {
          cols.push(col);
        }
      }
      if (focus !== undefined) next = { ...next, columns: cols };
    }
    out.push(next);
  }

  return { blocks: out, focus };
}

export function splitBlockAtSelection(
  blocks: readonly DocBlock[],
  blockId: string,
  selStart: number,
  selEnd = selStart,
  newId = makeBlockId(),
): { readonly blocks: DocBlock[]; readonly focus: BlockFocusTarget } | undefined {
  const res = splitBlocksInList(blocks, blockId, selStart, selEnd, newId);
  if (res.focus === undefined) return undefined;
  return { blocks: res.blocks, focus: res.focus };
}

function mergeBackwardInList(blocks: readonly DocBlock[], blockId: string): { readonly blocks: DocBlock[]; readonly focus?: BlockFocusTarget | undefined } {
  const idx = blocks.findIndex((b) => b.id === blockId);
  if (idx !== -1) {
    const cur = blocks[idx];
    if (cur.type === "heading" || cur.type === "todo" || cur.type === "quote") {
      const next = [...blocks];
      next[idx] = {
        id: cur.id,
        type: "prose",
        text: cur.text,
        ...(cur.children !== undefined ? { children: cur.children } : {}),
      };
      return { blocks: next, focus: { blockId: cur.id, caret: 0 } };
    }
    if (cur.type === "prose" && idx > 0) {
      const prev = blocks[idx - 1];
      if (prev.type === "prose" || prev.type === "heading" || prev.type === "todo" || prev.type === "quote") {
        const joinOffset = prev.text.length;
        const mergedPrev: DocBlock = {
          ...prev,
          text: `${prev.text}${cur.text}`,
          ...(cur.children !== undefined && cur.children.length > 0 ? { children: [...(prev.children ?? []), ...cur.children] } : {}),
        };
        const next = [...blocks.slice(0, idx - 1), mergedPrev, ...blocks.slice(idx + 1)];
        return { blocks: next, focus: { blockId: prev.id, caret: joinOffset } };
      }
      if (prev.type === "list" && prev.items.length > 0) {
        const lastIdx = prev.items.length - 1;
        const lastItem = prev.items[lastIdx] ?? "";
        const nextItems = [...prev.items];
        nextItems[lastIdx] = `${lastItem}${cur.text}`;
        const mergedPrev: DocBlock = { ...prev, items: nextItems };
        const next = [...blocks.slice(0, idx - 1), mergedPrev, ...blocks.slice(idx + 1)];
        return { blocks: next, focus: { blockId: prev.id, itemIndex: lastIdx, caret: lastItem.length } };
      }
      if (cur.text === "") {
        const next = [...blocks.slice(0, idx), ...blocks.slice(idx + 1)];
        return { blocks: next, focus: { blockId: prev.id, caret: "end" } };
      }
    }
    return { blocks: [...blocks] };
  }

  let focus: BlockFocusTarget | undefined;
  const out = blocks.map((b) => {
    let next = b;
    if (focus === undefined && next.children && next.children.length > 0) {
      const childRes = mergeBackwardInList(next.children, blockId);
      if (childRes.focus !== undefined) {
        focus = childRes.focus;
        next = { ...next, children: childRes.blocks };
      }
    }
    if (focus === undefined && next.type === "columns") {
      const cols: DocColumn[] = [];
      for (const col of next.columns) {
        if (focus === undefined) {
          const colRes = mergeBackwardInList(col.blocks, blockId);
          if (colRes.focus !== undefined) focus = colRes.focus;
          cols.push({ blocks: colRes.blocks });
        } else {
          cols.push(col);
        }
      }
      if (focus !== undefined) next = { ...next, columns: cols };
    }
    return next;
  });
  return { blocks: out, focus };
}

export function mergeBlockBackward(
  blocks: readonly DocBlock[],
  blockId: string,
): { readonly blocks: DocBlock[]; readonly focus: BlockFocusTarget } | undefined {
  const res = mergeBackwardInList(blocks, blockId);
  if (res.focus === undefined) return undefined;
  return { blocks: res.blocks, focus: res.focus };
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
