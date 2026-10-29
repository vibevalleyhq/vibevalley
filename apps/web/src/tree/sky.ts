// Where each memory sits in the sky around the tree, and the ties between them (the tree's own shape is grow.ts).

import type { MemoryItem, MemoryKind, MemoryLink, MemoryTree } from "./mock";
/** A star: where a memory sits in the sky's disc, before the camera turns it. */
export interface Star {
  readonly item: MemoryItem;
  /** On the disc, -1..1. */
  readonly x: number;
  readonly z: number;
  /** Above or below the disc. */
  readonly y: number;
  /** Pixels across in the sky's own pixels. */
  readonly size: number;
}

/** A number 0..1 from an id, the same every time. */
export function hash01(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return ((h >>> 0) % 100000) / 100000;
}

// Each kind's band from the middle, as fractions of the disc's radius: the seeds are the sun, the fruits ring it, the
// leaves are the dust outside. Within a band the older sit farther out, so the rings are time.
const bands: Record<MemoryKind, readonly [inner: number, outer: number]> = {
  seed: [0, 0.1],
  fruit: [0.16, 0.48],
  leaf: [0.42, 1],
};

export function starsOf(tree: MemoryTree, now: number): Star[] {
  const span = Math.max(1, now - tree.since);
  return tree.items.map((item) => {
    const [inner, outer] = bands[item.kind];
    const age = Math.min(1, Math.max(0, (now - item.at) / span));
    const jitter = (hash01(`${item.id}r`) - 0.5) * 0.12;
    const r = inner + (outer - inner) * Math.min(1, Math.max(0, age + jitter)) + (item.fading ? 0.08 : 0);
    const angle = hash01(item.id) * Math.PI * 2;
    const y = (hash01(`${item.id}y`) - 0.5) * (item.kind === "leaf" ? 0.08 : 0.04);
    const size = item.kind === "seed" ? 3 : item.kind === "fruit" ? (item.recalled > 5 ? 3 : 2) : 1;
    return { item, x: Math.cos(angle) * r, z: Math.sin(angle) * r, y, size };
  });
}

/** What a memory is tied to: what it grew from, what grew from it, what it is recalled with (the most often first). */
export interface Ties {
  readonly from: readonly string[];
  readonly grew: readonly string[];
  readonly together: readonly { readonly id: string; readonly times: number }[];
}

export function tiesOf(links: readonly MemoryLink[], id: string): Ties {
  const from: string[] = [];
  const grew: string[] = [];
  const together: { id: string; times: number }[] = [];
  for (const l of links) {
    if (l.kind === "from") {
      if (l.b === id) from.push(l.a);
      if (l.a === id) grew.push(l.b);
    } else if (l.a === id || l.b === id) together.push({ id: l.a === id ? l.b : l.a, times: l.times });
  }
  return { from, grew, together: together.sort((x, y) => y.times - x.times) };
}

/**
 * A memory's constellation: what it grew from, and what that grew from, up to the leaves; and what grew from it, down to
 * the seeds. Straight up and down only: a fruit shared by two seeds does not pull the other seed in.
 */
export function constellation(links: readonly MemoryLink[], id: string): Set<string> {
  const seen = new Set([id]);
  const walk = (start: string, up: boolean) => {
    const queue = [start];
    while (queue.length > 0) {
      const at = queue.shift()!;
      for (const l of links) {
        if (l.kind !== "from") continue;
        const next = up ? (l.b === at ? l.a : undefined) : l.a === at ? l.b : undefined;
        if (next !== undefined && !seen.has(next)) {
          seen.add(next);
          queue.push(next);
        }
      }
    }
  };
  walk(id, true);
  walk(id, false);
  return seen;
}
