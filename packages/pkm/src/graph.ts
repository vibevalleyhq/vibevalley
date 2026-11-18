import type * as T from "@vibevalley/protocol";
import { plainText } from "@vibevalley/protocol/rules";

import { blockRef, type Edge, edgesOf, find, type Node, type Page, walk, wikiLink, withoutSpans } from "./markdown.ts";
import { flatBlocks, slugOf } from "./outline.ts";
import { dayOf, journalDay, tierWeight } from "./para.ts";

/** The pages by slug. */
export type Vault = ReadonlyMap<string, Page>;

/** The page a name means: its slug, its title in any case, or one of its alias:: names. */
export function pageOf(vault: Vault, ref: string): Page | undefined {
  const slug = slugOf(ref);
  const bySlug = vault.get(slug);
  if (bySlug) return bySlug;
  const lower = ref.trim().toLowerCase();
  for (const page of vault.values()) {
    if (page.title.toLowerCase() === lower) return page;
    const aliases = new Set((page.props.alias ?? "").split(",").map((a) => a.trim().toLowerCase()));
    if (aliases.has(lower) || aliases.has(slug)) return page;
  }
  return undefined;
}

export interface Located {
  readonly page: Page;
  readonly node: Node;
  readonly block: T.PkmBlock;
}

export function blockOf(vault: Vault, id: string): Located | undefined {
  for (const page of vault.values()) {
    const node = find(page.blocks, id);
    const block = node && flatBlocks(page.blocks).find((b) => b.id === id);
    if (node && block) return { page, node, block };
  }
  return undefined;
}

const allEdges = (vault: Vault) => [...vault.values()].map((page) => ({ page, edges: edgesOf(page) }));

/** The ids some block refers to with ((id)): their files keep an id:: line so the ref survives a reading. */
export function refsInto(vault: Vault): Set<string> {
  const ids = new Set<string>();
  for (const { edges } of allEdges(vault)) for (const e of edges) if (e.target) ids.add(e.target);
  return ids;
}

export interface RefWords {
  readonly circular: (id: string) => string;
  readonly broken: (id: string) => string;
}

/** Each ((id)) on the page as it reads now, and in the blocks shown with it (its backlinks). */
export function transclusions(
  vault: Vault,
  page: Page,
  words: RefWords,
  shownWith: readonly { readonly block: string; readonly body: string }[] = [],
): T.PkmTransclusion[] {
  const out = new Map<string, T.PkmTransclusion>();
  const readOut = (id: string, seen: ReadonlySet<string>, depth: number): T.PkmTransclusion => {
    if (seen.has(id) || depth >= 2) return { block: id, found: true, circular: true, body: words.circular(id) };
    const at = blockOf(vault, id);
    if (!at) return { block: id, found: false, circular: false, body: words.broken(id) };
    const next = new Set([...seen, id]);
    const body = at.node.body.replace(blockRef, (_whole, inner: string) => readOut(inner, next, depth + 1).body);
    return { block: id, found: true, circular: false, page: at.page.slug, pageTitle: at.page.title, body };
  };
  for (const { block, body } of [...walk(page.blocks).map((node) => ({ block: node.id, body: node.body })), ...shownWith])
    for (const m of body.matchAll(blockRef)) {
      const id = m[1] ?? "";
      if (!out.has(id)) out.set(id, readOut(id, new Set([block]), 0));
    }
  return [...out.values()];
}

/** The blocks of other pages that link to slug, newest page first, by where their page is in PARA. */
export function backlinks(vault: Vault, slug: string): T.PkmBacklinks {
  const groups: T.PkmBacklinks = { projects: [], journals: [], areas: [], archives: [] };
  const linking = allEdges(vault)
    .filter(({ page }) => page.slug !== slug)
    .toSorted((a, b) => b.page.mtime - a.page.mtime);
  for (const { page, edges } of linking) {
    const ids = new Set(edges.filter((e) => e.page === slug).map((e) => e.block));
    if (ids.size === 0) continue;
    for (const block of flatBlocks(page.blocks)) {
      if (!ids.has(block.id)) continue;
      const link: T.PkmBacklink = {
        block: block.id,
        page: page.slug,
        pageTitle: page.title,
        tier: page.tier,
        path: plainPath(vault, block.path),
        body: block.body,
      };
      switch (page.tier) {
        case "project":
          groups.projects.push(link);
          break;
        case "journal":
          groups.journals.push(link);
          break;
        case "archive":
          groups.archives.push(link);
          break;
        case "inbox":
        case "area":
        case "resource":
          groups.areas.push(link);
          break;
      }
    }
  }
  return groups;
}

const openMarkers: ReadonlySet<T.PkmMarker> = new Set(["TODO", "DOING", "NOW", "LATER", "WAITING"]);

export const summaryOf = (page: Page): T.PkmPageSummary => {
  let open = 0;
  for (const node of walk(page.blocks)) if (node.marker && openMarkers.has(node.marker)) open += 1;
  const day = page.tier === "journal" ? journalDay(page.file) : undefined;
  return {
    slug: page.slug,
    title: page.title,
    tier: page.tier,
    file: page.file,
    tldr: page.props.tldr ?? "",
    updated: page.mtime,
    open,
    ...(day ? { day } : {}),
  };
};

const plainPath = (vault: Vault, path: string) =>
  path === ""
    ? ""
    : path
        .split(" > ")
        .map((step) => plainOf(vault, step))
        .join(" > ");

/** A block's text as one line: a ((ref)) read out one level only (a nested one as …), a [[link]] as its words. */
export function plainOf(vault: Vault, body: string): string {
  const refsOut = body.replace(blockRef, (_whole, id: string) => blockOf(vault, id)?.node.body.replace(blockRef, "…") ?? "…");
  const linksOut = withoutSpans(refsOut).replace(wikiLink, (_whole, inner: string) => (inner.split("|").at(-1) ?? inner).trim());
  return plainText(linksOut);
}

export const wireOf = (page: Page): T.PkmPage => ({
  slug: page.slug,
  title: page.title,
  tier: page.tier,
  file: page.file,
  props: { ...page.props },
  tldr: page.props.tldr ?? "",
  blocks: flatBlocks(page.blocks),
  updated: page.mtime,
});

const defaultTokenize = (text: string): readonly string[] => text.toLowerCase().match(/[\p{Script=Han}]{2,}|[a-z0-9_][a-z0-9_.\-/]*[a-z0-9_]/gu) ?? [];

/** The words a search matches on: the whole query, its space-separated words and the words the tokenizer cuts it into. */
export const queryWords = (text: string, tokenize: (s: string) => readonly string[] = defaultTokenize): string[] => {
  const lower = text.trim().toLowerCase();
  return [...new Set([...lower.split(/\s+/u), ...tokenize(text)].filter((w) => w !== ""))];
};

/** The blocks that match, best first, times the tier's weight. */
export function search(
  vault: Vault,
  req: T.PkmSearchRequest,
  ranked?: ReadonlyMap<string, number>,
  tokenize: (s: string) => readonly string[] = defaultTokenize,
): T.PkmSearchHit[] {
  const limit = req.limit !== undefined && req.limit > 0 ? req.limit : 10;
  const text = req.text?.trim() ?? "";
  const words = text ? queryWords(text, tokenize) : [];
  const whole = text.toLowerCase();
  const linked = req.linkedTo ? slugOf(req.linkedTo) : undefined;
  const hits: T.PkmSearchHit[] = [];
  const pages = [...vault.values()].toSorted((a, b) => b.mtime - a.mtime);
  for (const page of pages) {
    if (req.tier && page.tier !== req.tier) continue;
    const linking = linked
      ? new Set(
          edgesOf(page)
            .filter((e: Edge) => e.page === linked)
            .map((e) => e.block),
        )
      : undefined;
    const blocks = flatBlocks(page.blocks);
    for (const [i, block] of blocks.entries()) {
      if (req.marker && block.marker !== req.marker) continue;
      if (linking && !linking.has(block.id)) continue;
      let score = 1;
      if (text) {
        const hay = `${page.title}\n${block.path}\n${block.body}\n${Object.entries(block.props)
          .map(([k, v]) => `${k}:${v}`)
          .join(" ")}`.toLowerCase();
        const found = ranked ? ranked.get(block.id) : words.filter((w) => hay.includes(w)).length;
        if (found === undefined || (!ranked && found === 0)) continue;
        score = found + (hay.includes(whole) ? 2 : 0);
      }
      const children: T.PkmBlock[] = [];
      for (const next of blocks.slice(i + 1)) {
        if (next.depth <= block.depth) break;
        children.push(next);
      }
      hits.push({
        block: block.id,
        page: page.slug,
        pageTitle: page.title,
        tier: page.tier,
        ...(block.marker ? { marker: block.marker } : {}),
        path: plainPath(vault, block.path),
        body: block.body,
        plain: plainOf(vault, block.body),
        score: score * tierWeight[page.tier],
        children,
      });
    }
  }
  return hits.toSorted((a, b) => b.score - a.score).slice(0, limit);
}

const dayMs = 24 * 60 * 60 * 1000;

export function radar(vault: Vault, now: number, staleDays: number): T.PkmRadar {
  const today = dayOf(now);
  const out: T.PkmRadar = { inbox: 0, stale: [], overdue: [] };
  for (const page of [...vault.values()].toSorted((a, b) => a.slug.localeCompare(b.slug))) {
    if (page.tier === "inbox") out.inbox += 1;
    const status = page.props.status;
    if (page.tier === "project" && status !== "completed" && status !== "archived" && now - page.mtime >= staleDays * dayMs) {
      const count = { todo: 0, doing: 0, done: 0 };
      for (const node of walk(page.blocks)) {
        if (node.marker === "TODO" || node.marker === "LATER") count.todo += 1;
        else if (node.marker === "DOING" || node.marker === "NOW") count.doing += 1;
        else if (node.marker === "DONE") count.done += 1;
      }
      out.stale.push({
        slug: page.slug,
        title: page.title,
        days: Math.max(Math.floor((now - page.mtime) / dayMs), staleDays),
        ...(page.props.deadline ? { deadline: page.props.deadline } : {}),
        ...count,
      });
    }
    for (const node of walk(page.blocks)) {
      const deadline = node.props.deadline;
      if (deadline && deadline < today && node.marker !== "DONE" && node.marker !== "CANCELED")
        out.overdue.push({ block: node.id, page: page.slug, body: node.body, plain: plainOf(vault, node.body), deadline });
    }
  }
  return out;
}

/** The page as plain Markdown to hand to someone: ((refs)) read out, [[links]] as their words, remarks taken off. */
export function exportMarkdown(vault: Vault, page: Page, summary: (tldr: string) => string): string {
  const lines = [`# ${page.title}`, ""];
  const tldr = page.props.tldr;
  if (tldr) lines.push(summary(tldr), "");
  const plain = (text: string) =>
    withoutSpans(text.replace(blockRef, (_whole, id: string) => blockOf(vault, id)?.node.body ?? ""))
      .replace(/\[\[([^[\]|]+)\|([^[\]]+)\]\]/gu, "$2")
      .replace(/\[\[([^[\]]+)\]\]/gu, "$1");
  const go = (nodes: readonly Node[], level: number) => {
    for (const node of nodes) {
      const body = plain(node.body);
      if (body.startsWith("## ") || body.startsWith("### ")) lines.push(body, "");
      else if (level === 0 && node.children.length > 0 && !body.startsWith("![")) lines.push(`### ${body}`, "");
      else lines.push(`${level <= 1 ? "" : "  ".repeat(level - 1)}- ${body}`);
      if (node.children.length > 0) {
        go(node.children, level + 1);
        if (level === 0) lines.push("");
      }
    }
  };
  go(page.blocks, 0);
  return `${lines.join("\n").trim()}\n`;
}

const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");

/** The page with every [[from]] (or [[from|words]]) in its blocks and props said as [[to]]; undefined when it has none. */
export function renameLinks(page: Page, from: string, to: string): Page | undefined {
  const link = new RegExp(`\\[\\[${escaped(from)}(\\|[^\\[\\]]+)?\\]\\]`, "giu");
  let changed = false;
  const said = (text: string) => {
    const next = text.replace(link, (_whole, words: string | undefined) => `[[${to}${words ?? ""}]]`);
    if (next !== text) changed = true;
    return next;
  };
  const props = Object.fromEntries(Object.entries(page.props).map(([k, v]) => [k, said(v)]));
  const relink = (nodes: readonly Node[]): Node[] =>
    nodes.map((n) => ({
      ...n,
      body: said(n.body),
      props: Object.fromEntries(Object.entries(n.props).map(([k, v]) => [k, said(v)])),
      children: relink(n.children),
    }));
  const blocks = relink(page.blocks);
  return changed ? { ...page, props, blocks } : undefined;
}

const linksIn = (text: string) => [
  ...[...text.matchAll(wikiLink)].map((m) => `[[${(m[1] ?? "").trim()}]]`),
  ...[...text.matchAll(blockRef)].map((m) => `((${m[1] ?? ""}))`),
];

/** A proposed text that keeps every link the old one had: the dropped ones are put back at its end. */
export function keepLinks(old: string, proposed: string): { readonly text: string; readonly kept: string[]; readonly restored: string[] } {
  const kept = linksIn(old);
  let text = proposed;
  const restored: string[] = [];
  for (const link of kept)
    if (!text.includes(link)) {
      text = `${text} ${link}`;
      restored.push(link);
    }
  return { text, kept, restored };
}

/** The inbox, journal and resource blocks about a topic (in their text or their page's title), newest page first. */
export function clustered(vault: Vault, topic: string): { readonly page: Page; readonly node: Node }[] {
  const lower = topic.trim().toLowerCase();
  const out: { page: Page; node: Node }[] = [];
  for (const page of [...vault.values()].toSorted((a, b) => b.mtime - a.mtime)) {
    if (page.tier !== "inbox" && page.tier !== "journal" && page.tier !== "resource") continue;
    const titled = page.title.toLowerCase().includes(lower);
    for (const node of walk(page.blocks)) if (titled || node.body.toLowerCase().includes(lower)) out.push({ page, node });
  }
  return out;
}

/** The page whose source-url:: is url, a clip of it already. */
export const clipOf = (vault: Vault, url: string) => [...vault.values()].find((p) => p.props["source-url"] === url);
