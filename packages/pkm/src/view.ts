import type { PkmBlock, PkmPageSummary, PkmTier } from "@vibevalley/protocol";

import { titleFor } from "./days.ts";
import { pkmTag, slugOf } from "./outline.ts";

/** The tiers in the list's order: what is worked on first, what is done with last. */
export const tierOrder: readonly PkmTier[] = ["project", "area", "resource", "inbox", "journal", "archive"];

/** Whether the block at i has blocks under it (the list is in the page's order, pre-order). */
export const hasChildren = (blocks: readonly PkmBlock[], i: number) => (blocks[i + 1]?.depth ?? -1) > (blocks[i]?.depth ?? 0);

/** The blocks shown: none under a collapsed one. */
export function visibleBlocks(blocks: readonly PkmBlock[], collapsed: ReadonlySet<string>): PkmBlock[] {
  const out: PkmBlock[] = [];
  let hiddenUnder: number | undefined;
  for (const b of blocks) {
    if (hiddenUnder !== undefined && b.depth > hiddenUnder) continue;
    hiddenUnder = undefined;
    out.push(b);
    if (collapsed.has(b.id)) hiddenUnder = b.depth;
  }
  return out;
}

export interface Heading {
  readonly level: 1 | 2 | 3;
  /** Length of the leading `# ` / `## ` / `### ` prefix. */
  readonly prefix: number;
}

/** Leading `# `, `## `, or `### ` heading level and prefix length, if any. */
export function headingOf(body: string): Heading | undefined {
  const m = /^(#{1,3})\s/u.exec(body);
  if (!m?.[1]) return undefined;
  const level = m[1].length;
  if (level !== 1 && level !== 2 && level !== 3) return undefined;
  return { level, prefix: m[0].length };
}

export type BodySegment = { readonly kind: "text"; readonly text: string } | { readonly kind: "code"; readonly lang: string; readonly code: string };

const fenceOpen = /^(`{3,}|~{3,})([^\n]*)$/u;

/** Splits a block containing at least one closed fenced code block into ordered text and code segments; undefined when none. */
export function fencedCode(body: string): readonly BodySegment[] | undefined {
  if (!body.includes("```") && !body.includes("~~~")) return undefined;
  const lines = body.split("\n");
  const out: BodySegment[] = [];
  let textLines: string[] = [];
  let hasCode = false;
  const flushText = () => {
    if (textLines.length > 0) {
      out.push({ kind: "text", text: textLines.join("\n") });
      textLines = [];
    }
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const open = fenceOpen.exec(line.trimStart());
    if (open?.[1]) {
      const fence = open[1];
      let close = -1;
      for (let j = i + 1; j < lines.length; j += 1) {
        if ((lines[j] ?? "").trim() === fence) {
          close = j;
          break;
        }
      }
      if (close !== -1) {
        flushText();
        hasCode = true;
        out.push({ kind: "code", lang: (open[2] ?? "").trim(), code: lines.slice(i + 1, close).join("\n") });
        i = close;
        continue;
      }
    }
    textLines.push(line);
  }
  if (!hasCode) return undefined;
  flushText();
  return out;
}

export type Piece =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "link"; readonly page: string; readonly text: string }
  | { readonly kind: "tag"; readonly page: string; readonly text: string }
  | { readonly kind: "ref"; readonly id: string }
  | { readonly kind: "remark"; readonly text: string; readonly remark: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "bold"; readonly text: string }
  | { readonly kind: "italic"; readonly text: string }
  | { readonly kind: "strike"; readonly text: string }
  | { readonly kind: "url"; readonly text: string; readonly url: string };

// CJK sentence punctuation excluded from bare URLs (，。；：！？）》】」』).
const cjkStop = String.raw`\uFF0C\u3002\uFF1B\uFF1A\uFF01\uFF1F\uFF09\u300B\u3011\u300D\u300F`;

// Order matters: inline `code` must win before wikilinks, tags, URLs and emphasis; [label](url) before bare URLs; **bold** before *italic*.
const inline = new RegExp(
  [
    "`([^`\\n]+)`", // 1: code
    String.raw`==([^=]+)==\^\[([^\]]+)\]`, // 2, 3: remark
    String.raw`\[\[([^[\]]+?)\]\]`, // 4: wikilink
    String.raw`\(\(([0-9a-fA-F-]{8,36})\)\)`, // 5: block ref
    String.raw`\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)`, // 6, 7: markdown url
    String.raw`(https?:\/\/[^\s<>)[\]${cjkStop}]+[^\s<>)[\].,;:!?${cjkStop}])`, // 8: bare url
    String.raw`\*\*([^*\n]+?)\*\*`, // 9: bold
    String.raw`~~([^~\n]+?)~~`, // 10: strike
    String.raw`(?<!\*)\*([^\s*\n](?:[^*\n]*?[^\s*\n])?)\*(?!\*)`, // 11: italic
    pkmTag.source, // 12: #tag
  ].join("|"),
  "gu",
);

/** A block's text as pieces: `code`, ==words==^[remark], [[page]] links, ((block)) refs, URLs, emphasis, #tags, and plain text. */
export function piecesOf(body: string): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  const text = (s: string) => {
    if (s) out.push({ kind: "text", text: s });
  };
  for (const m of body.matchAll(inline)) {
    const start = m.index;
    text(body.slice(at, start));
    if (m[1] !== undefined) {
      out.push({ kind: "code", text: m[1] });
    } else if (m[2] !== undefined) {
      out.push({ kind: "remark", text: m[2], remark: (m[3] ?? "").replace(/^💬\s*/u, "").trim() });
    } else if (m[4] !== undefined) {
      const [page = "", words] = m[4].split("|");
      out.push({ kind: "link", page: slugOf(page), text: (words ?? page).trim() });
    } else if (m[5] !== undefined) {
      out.push({ kind: "ref", id: m[5] });
    } else if (m[6] !== undefined && m[7] !== undefined) {
      out.push({ kind: "url", text: m[6], url: m[7] });
    } else if (m[8] !== undefined) {
      out.push({ kind: "url", text: m[8], url: m[8] });
    } else if (m[9] !== undefined) {
      out.push({ kind: "bold", text: m[9] });
    } else if (m[10] !== undefined) {
      out.push({ kind: "strike", text: m[10] });
    } else if (m[11] !== undefined) {
      out.push({ kind: "italic", text: m[11] });
    } else {
      out.push({ kind: "tag", page: slugOf(m[12] ?? ""), text: `#${m[12] ?? ""}` });
    }
    at = start + m[0].length;
  }
  text(body.slice(at));
  return out;
}

export interface DiffPiece {
  readonly kind: "same" | "add" | "del";
  readonly text: string;
}

const word = /\p{Script=Han}|[\p{L}\p{N}_]+|\s+|[^\s]/gu;

/** The rewrite against the text it replaces, word by word (longest common run kept, the rest deleted or added). */
export function wordDiff(was: string, now: string): DiffPiece[] {
  const a = was.match(word) ?? [];
  const b = now.match(word) ?? [];
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => Array.from({ length: m + 1 }, () => 0));
  for (let i = n - 1; i >= 0; i -= 1) {
    const row = lcs[i] ?? [];
    const below = lcs[i + 1] ?? [];
    for (let j = m - 1; j >= 0; j -= 1) row[j] = a[i] === b[j] ? (below[j + 1] ?? 0) + 1 : Math.max(below[j] ?? 0, row[j + 1] ?? 0);
  }
  const out: DiffPiece[] = [];
  const push = (kind: DiffPiece["kind"], text: string) => {
    const last = out.at(-1);
    if (last?.kind === kind) out[out.length - 1] = { kind, text: last.text + text };
    else out.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      push("same", a[i] ?? "");
      i += 1;
      j += 1;
    } else if ((lcs[i + 1]?.[j] ?? 0) >= (lcs[i]?.[j + 1] ?? 0)) push("del", a[i++] ?? "");
    else push("add", b[j++] ?? "");
  }
  while (i < n) push("del", a[i++] ?? "");
  while (j < m) push("add", b[j++] ?? "");
  return out;
}

export interface NoteTarget {
  readonly slug: string;
  readonly label: string;
  readonly tier: PkmTier;
}

const defaultMatch = (text: string, query: string) => text.toLowerCase().includes(query);

/** The pages whose title (a journal's day too) has what was typed in it, the newest first; none for nothing typed. */
export function noteTargets(
  pages: readonly PkmPageSummary[],
  query: string,
  max = 6,
  match: (text: string, query: string) => boolean = defaultMatch,
): NoteTarget[] {
  const typed = query.trim().toLowerCase();
  if (typed === "") return [];
  return pages
    .map((p) => ({ slug: p.slug, label: titleFor(p.title, p.day), tier: p.tier, updated: p.updated, title: p.title }))
    .filter((p) => match(p.label, typed) || match(p.title, typed))
    .toSorted((a, b) => b.updated - a.updated)
    .slice(0, max)
    .map(({ slug, label, tier }) => ({ slug, label, tier }));
}
