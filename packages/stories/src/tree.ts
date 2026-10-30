// A title is a path ("组件/工作台/Button"): each part but the last is a folder, the last is the file's folder of
// stories. A file with one story is that story itself, named by the title's last part.

import type { Stories, Story } from "./format";

export interface Entry {
  /** "组件/工作台/Button:Tones": the address of one story. */
  readonly key: string;
  readonly title: string;
  readonly name: string;
  readonly story: Story;
  readonly themes: readonly ("light" | "dark")[];
  readonly frame: string | undefined;
}

export type Node =
  | { readonly kind: "folder"; readonly path: string; readonly name: string; readonly depth: number; readonly children: Node[] }
  | { readonly kind: "story"; readonly name: string; readonly depth: number; readonly entry: Entry };

/**
 * Orders titles part by part: at each depth, a path named in `order` comes before one that is not, in the order given;
 * the rest by name. `order` holds paths ("设计体系", "组件/工作台"), so a level and the folders inside it are both ordered.
 */
export function compareTitles(order: readonly string[]) {
  const rank = (path: string) => {
    const i = order.indexOf(path);
    return i === -1 ? order.length : i;
  };
  return (a: string, b: string) => {
    const pa = a.split("/");
    const pb = b.split("/");
    for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
      if (pa[i] === pb[i]) continue;
      const head = (p: string[]) => p.slice(0, i + 1).join("/");
      const byRank = rank(head(pa)) - rank(head(pb));
      return byRank !== 0 ? byRank : pa[i]!.localeCompare(pb[i]!);
    }
    return pa.length - pb.length;
  };
}

/** Every story, its file's title ordered by `order`, its stories as written. Two files with one title is a mistake. */
export function entries(modules: readonly Stories[], order: readonly string[] = []): Entry[] {
  const seen = new Set<string>();
  const compare = compareTitles(order);
  return [...modules]
    .sort((a, b) => compare(a.title, b.title))
    .flatMap((m) => {
      if (seen.has(m.title)) throw new Error(`two stories files are titled ${m.title}`);
      seen.add(m.title);
      return Object.entries(m.stories).map(([name, story]) => ({
        key: `${m.title}:${name}`,
        title: m.title,
        name,
        story,
        themes: m.themes ?? ["light", "dark"],
        frame: m.frame,
      }));
    });
}

export function search(list: readonly Entry[], q: string): Entry[] {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  return list.filter((e) => words.every((w) => e.key.toLowerCase().includes(w)));
}

export function treeOf(list: readonly Entry[]): Node[] {
  const roots: Node[] = [];
  const folders = new Map<string, Node[]>();
  const folder = (parts: string[]): Node[] => {
    if (parts.length === 0) return roots;
    const path = parts.join("/");
    let children = folders.get(path);
    if (!children) {
      children = [];
      folders.set(path, children);
      folder(parts.slice(0, -1)).push({ kind: "folder", path, name: parts.at(-1) ?? path, depth: parts.length - 1, children });
    }
    return children;
  };
  const counts = new Map<string, number>();
  for (const e of list) counts.set(e.title, (counts.get(e.title) ?? 0) + 1);
  for (const e of list) {
    const parts = e.title.split("/");
    if (counts.get(e.title) === 1) folder(parts.slice(0, -1)).push({ kind: "story", name: parts.at(-1) ?? e.title, depth: parts.length - 1, entry: e });
    else folder(parts).push({ kind: "story", name: e.name, depth: parts.length, entry: e });
  }
  return roots;
}

/** The folders a story is in, outermost first. */
export function ancestors(title: string): string[] {
  const parts = title.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

/** Open: what was opened or closed by hand, else the levels and the folders around the open story. */
export function isOpen(path: string, depth: number, at: string | undefined, toggled: ReadonlyMap<string, boolean>): boolean {
  const kept = toggled.get(path);
  if (kept !== undefined) return kept;
  return depth === 0 || (at !== undefined && ancestors(at).includes(path));
}
