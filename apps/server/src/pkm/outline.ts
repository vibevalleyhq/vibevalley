// A page's file as an outline and back (Logseq's Markdown): key:: value lines at the top are the page's props; each
// "- " bullet is a block, two spaces of indent a level; a block's key:: value lines right under its first line are its
// props (id:: is its id); a fenced code block inside a bullet is text, whatever it holds. print(parse(x)) is x for a file
// this printer wrote (props in their order, two-space indent, no trailing spaces).

import { createHash } from "node:crypto";

import { PkmMarkerValues } from "@vibevalley/protocol";
import type * as T from "@vibevalley/protocol";
import { slugOf } from "@vibevalley/protocol/rules";

import { tierOfFile, titleOfFile } from "./para.ts";

/** A block as the server holds it: the page's outline is a tree of these. */
export interface Node {
  id: string;
  depth: number;
  marker?: T.PkmMarker;
  priority?: T.PkmPriority;
  body: string;
  props: Record<string, string>;
  /** Its id is written in the file (id::), so it stays when the file is read again. */
  explicit: boolean;
  children: Node[];
}

export interface Page {
  slug: string;
  title: string;
  tier: T.PkmTier;
  /** Relative to the vault, with forward slashes. */
  file: string;
  props: Record<string, string>;
  blocks: Node[];
  /** sha256 of the file's text, \r\n as \n: a file whose hash is this one is the page as held. */
  sha: string;
  mtime: number;
}

export type RefKind = "wikilink" | "tag" | "block_ref" | "prop_link";

/** A link out of a block: to a page (by slug) or to a block (by id). */
export interface Edge {
  block: string;
  page?: string;
  target?: string;
  kind: RefKind;
}

/** An inline remark: ==the words==^[the remark]. */
export interface Span {
  text: string;
  remark: string;
}

const pageOrder = [
  "title",
  "para",
  "status",
  "area",
  "deadline",
  "tags",
  "alias",
  "material-type",
  "source-url",
  "author",
  "read-status",
  "clipped-at",
  "snapshot",
  "tldr",
];
const blockOrder = ["collapsed", "id", "completed", "deadline", "scheduled", "render", "caption", "source-anchor", "comment"];

const propLine = /^([a-zA-Z0-9_-]+)::\s*(.*)$/u;
/** A bullet; a bare - (an empty block, its space trimmed by an editor) is one too. */
const bulletLine = /^(\s*)-(?:\s(.*))?$/u;
const markerLead = new RegExp(`^(${PkmMarkerValues.join("|")})(?:\\s+\\[#([ABC])\\])?\\s+(.*)$`, "su");
const priorityLead = /^\[#([ABC])\]\s+(.*)$/su;
const fenceLead = /^(`{3,}|~{3,})/u;
export const wikiLink = /\[\[([^[\]]+?)\]\]/gu;
export const blockRef = /\(\(([0-9a-fA-F-]{8,36})\)\)/gu;
const tagRef = /(?:^|\s)#([\p{L}\p{N}_/-]+)/gu;
const spanRemark = /==([^=]+)==\^\[([^\]]+)\]/gu;

const shaOf = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** A uuid-shaped id from a seed: the same seed, the same id. */
function seededId(seed: string): string {
  const h = shaOf(seed);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

const isMarker = (word: string | undefined): word is T.PkmMarker => PkmMarkerValues.some((m) => m === word);
const isPriority = (word: string | undefined): word is T.PkmPriority => word === "A" || word === "B" || word === "C";

/** The file's text as a page; ids not written in it are made from where the block is (seededId). */
export function parse(text: string, file: string, mtime: number): Page {
  const normal = text.replace(/\r\n/gu, "\n");
  const lines = normal.split("\n");
  const props: Record<string, string> = {};
  let i = 0;
  for (; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim() === "") continue;
    if (bulletLine.test(line)) break;
    const prop = propLine.exec(line);
    if (!prop) break;
    props[prop[1] ?? ""] = (prop[2] ?? "").trim();
  }
  const title = props.title || titleOfFile(file);
  const slug = slugOf(title);

  const roots: Node[] = [];
  const stack: Node[] = [];
  let current: Node | undefined;
  let fence = "";
  let readingProps = false;
  let count = 0;
  for (; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (fence && current) {
      const body = unindent(line, current.depth);
      current.body += `\n${body}`;
      if (body.trimStart().startsWith(fence)) fence = "";
      continue;
    }
    const bullet = bulletLine.exec(line);
    if (bullet) {
      // A jump of more than one level is read as one level deeper.
      const depth = Math.min(Math.floor((bullet[1] ?? "").replace(/\t/gu, "  ").length / 2), stack.length);
      stack.length = depth;
      const parent = stack.at(-1);
      let content = bullet[2] ?? "";
      let marker: T.PkmMarker | undefined;
      let priority: T.PkmPriority | undefined;
      const lead = markerLead.exec(content);
      if (lead && isMarker(lead[1])) {
        marker = lead[1];
        priority = isPriority(lead[2]) ? lead[2] : undefined;
        content = lead[3] ?? "";
      } else {
        const only = priorityLead.exec(content);
        if (only && isPriority(only[1])) {
          priority = only[1];
          content = only[2] ?? "";
        }
      }
      count += 1;
      const node: Node = {
        id: seededId(`${slug}::${count}`),
        depth,
        ...(marker ? { marker } : {}),
        ...(priority ? { priority } : {}),
        body: content,
        props: {},
        explicit: false,
        children: [],
      };
      (parent ? parent.children : roots).push(node);
      stack.push(node);
      current = node;
      readingProps = true;
      const opens = fenceLead.exec(content.trimStart());
      if (opens) {
        fence = opens[1] ?? "";
        readingProps = false;
      }
      continue;
    }
    if (!current) continue;
    if (line.trim() === "" && i === lines.length - 1) continue;
    const body = unindent(line, current.depth);
    const opens = fenceLead.exec(body.trimStart());
    if (opens) {
      fence = opens[1] ?? "";
      readingProps = false;
      current.body += `\n${body}`;
      continue;
    }
    if (readingProps) {
      const prop = propLine.exec(body);
      if (prop) {
        if (prop[1] === "id") {
          current.id = (prop[2] ?? "").trim();
          current.explicit = true;
        } else current.props[prop[1] ?? ""] = (prop[2] ?? "").trim();
        continue;
      }
    }
    if (line.trim() !== "") {
      readingProps = false;
      current.body += `\n${body}`;
    }
  }
  return { slug, title, tier: tierOfFile(file), file, props, blocks: roots, sha: shaOf(normal), mtime };
}

/** A continuation line without its block's indent (or without any, when it is indented less). */
function unindent(line: string, depth: number) {
  const indent = "  ".repeat(depth + 1);
  return line.startsWith(indent) ? line.slice(indent.length) : line.trimStart();
}

const sortedKeys = (keys: readonly string[], order: readonly string[]) =>
  [...keys].toSorted((a, b) => {
    const ia = order.indexOf(a);
    const ib = order.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

/** Whether a block's id goes into the file: one written there already, one something refers to or remarks on. */
const writesId = (node: Node, referenced: ReadonlySet<string>) =>
  node.explicit || referenced.has(node.id) || Boolean(node.props.comment) || spansOf(node.body).length > 0;

/** The page as its file. referenced: the ids something in the vault refers to (refsInto) or has a remark on. */
export function print(page: Pick<Page, "props" | "blocks">, referenced: ReadonlySet<string> = new Set()): string {
  const out: string[] = [];
  for (const key of sortedKeys(Object.keys(page.props), pageOrder)) {
    const value = page.props[key];
    if (value !== undefined && value !== "") out.push(`${key}:: ${value}`);
  }
  if (out.length > 0 && page.blocks.length > 0) out.push("");
  const trimEnd = (s: string) => s.replace(/[ \t]+$/u, "");
  const write = (node: Node) => {
    const indent = "  ".repeat(node.depth);
    const more = "  ".repeat(node.depth + 1);
    const lead = `${indent}- ${node.marker ? `${node.marker} ` : ""}${node.priority ? `[#${node.priority}] ` : ""}`;
    const [first = "", ...rest] = node.body.split("\n");
    out.push(trimEnd(lead + first));
    const props: Record<string, string> = { ...node.props };
    if (writesId(node, referenced)) props.id = node.id;
    for (const key of sortedKeys(Object.keys(props), blockOrder)) {
      const value = props[key];
      if (value !== undefined && value !== "") out.push(trimEnd(`${more}${key}:: ${value}`));
    }
    for (const line of rest) out.push(trimEnd(more + line));
    for (const child of node.children) write(child);
  };
  for (const node of page.blocks) write(node);
  return `${out.join("\n")}\n`;
}

const withoutFences = (text: string) => text.replace(/(`{3,}|~{3,})[\s\S]*?\1/gu, "");

export function spansOf(body: string): Span[] {
  return [...withoutFences(body).matchAll(spanRemark)].map((m) => ({ text: (m[1] ?? "").trim(), remark: (m[2] ?? "").replace(/^💬\s*/u, "").trim() }));
}

/** The body with its ==span==^[remark] marks taken off, the words left. */
export const withoutSpans = (body: string) => body.replace(spanRemark, "$1");

/** Every block of the outline, depth first, in the page's order. */
export function walk(nodes: readonly Node[]): Node[] {
  return nodes.flatMap((node) => [node, ...walk(node.children)]);
}

export function find(nodes: readonly Node[], id: string): Node | undefined {
  for (const node of walk(nodes)) if (node.id === id) return node;
  return undefined;
}

/** The links out of each block: [[pages]], #tags, ((blocks)) and [[pages]] in its props; none inside code. */
export function edgesOf(page: Pick<Page, "blocks">): Edge[] {
  const edges: Edge[] = [];
  for (const node of walk(page.blocks)) {
    const text = withoutFences(node.body);
    for (const m of text.matchAll(wikiLink)) {
      const target = (m[1] ?? "").split("|")[0]?.trim() ?? "";
      if (target && !target.startsWith(".")) edges.push({ block: node.id, page: slugOf(target), kind: "wikilink" });
    }
    for (const m of text.matchAll(blockRef)) edges.push({ block: node.id, target: m[1] ?? "", kind: "block_ref" });
    for (const m of text.matchAll(tagRef)) edges.push({ block: node.id, page: slugOf(m[1] ?? ""), kind: "tag" });
    for (const value of Object.values(node.props))
      for (const m of value.matchAll(wikiLink)) {
        const target = (m[1] ?? "").split("|")[0]?.trim() ?? "";
        if (target) edges.push({ block: node.id, page: slugOf(target), kind: "prop_link" });
      }
  }
  return edges;
}

/** The ids of page's blocks not written in its file taken from was where a block reads the same at the same depth: a page
 * read again after another editor changed it keeps the ids of the blocks that did not change. */
export function carryIds(was: Page, page: Page): Page {
  const free = new Map<string, string[]>();
  const key = (n: Node) => `${n.depth}\u0000${n.marker ?? ""}\u0000${n.body}`;
  const explicit = new Set<string>();
  for (const n of walk(page.blocks)) if (n.explicit) explicit.add(n.id);
  const held = new Set<string>();
  for (const n of walk(was.blocks)) {
    held.add(n.id);
    if (explicit.has(n.id)) continue;
    const k = key(n);
    free.set(k, [...(free.get(k) ?? []), n.id]);
  }
  // A block not matched keeps its seeded id unless an id it had before went to another block.
  const relabel = (nodes: Node[]): Node[] =>
    nodes.map((n) => {
      const reuse = n.explicit ? undefined : free.get(key(n))?.shift();
      const id = reuse ?? (!n.explicit && held.has(n.id) ? seededId(`${page.sha}::${n.id}`) : n.id);
      return { ...n, id, children: relabel(n.children) };
    });
  return { ...page, blocks: relabel(page.blocks) };
}
