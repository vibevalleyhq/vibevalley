import type { PkmBlock, PkmPageSummary, PkmTier } from "@vibevalley/protocol";
import { pkmTag, slugOf } from "@vibevalley/protocol/rules";

import { titleFor } from "./days.ts";

/** The tiers in the list's order: what is worked on first, what is done with last. */
export const tierOrder: readonly PkmTier[] = ["project", "area", "resource", "inbox", "journal", "archive"];

export function byTier(pages: readonly PkmPageSummary[]): { readonly tier: PkmTier; readonly pages: readonly PkmPageSummary[] }[] {
  return tierOrder.map((tier) => ({ tier, pages: pages.filter((p) => p.tier === tier) })).filter((g) => g.pages.length > 0);
}

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

export type Piece =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "link"; readonly page: string; readonly text: string }
  | { readonly kind: "tag"; readonly page: string; readonly text: string }
  | { readonly kind: "ref"; readonly id: string }
  | { readonly kind: "remark"; readonly text: string; readonly remark: string };

const inline = new RegExp(String.raw`==([^=]+)==\^\[([^\]]+)\]|\[\[([^[\]]+?)\]\]|\(\(([0-9a-fA-F-]{8,36})\)\)|` + pkmTag.source, "gu");

/** A block's text as pieces: ==words==^[remark] inline remarks, [[page]] or [[page|words]] links, #tags, ((block)) refs
 * and the text between. */
export function piecesOf(body: string): Piece[] {
  const out: Piece[] = [];
  let at = 0;
  const text = (s: string) => {
    if (s) out.push({ kind: "text", text: s });
  };
  for (const m of body.matchAll(inline)) {
    const start = m.index;
    if (m[1] !== undefined) {
      text(body.slice(at, start));
      out.push({ kind: "remark", text: m[1], remark: (m[2] ?? "").replace(/^💬\s*/u, "").trim() });
    } else if (m[3] !== undefined) {
      text(body.slice(at, start));
      const [page = "", words] = m[3].split("|");
      out.push({ kind: "link", page: slugOf(page), text: (words ?? page).trim() });
    } else if (m[4] !== undefined) {
      text(body.slice(at, start));
      out.push({ kind: "ref", id: m[4] });
    } else {
      text(body.slice(at, start));
      out.push({ kind: "tag", page: slugOf(m[5] ?? ""), text: `#${m[5] ?? ""}` });
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
