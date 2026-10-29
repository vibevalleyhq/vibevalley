// The memory tree's shape, grown from the memories rather than drawn: one fixed genome (the same branches every time),
// unfolded as far as the farm has grown, with every leaf memory a leaf in the crown and every fruit on a branch tip.
// Pure: Scene.tsx draws what this returns. Coordinates are the tree's own: x to the right, y up, the foot at 0, 0, in
// the scene's pixels.

import type { MemoryItem } from "./mock";
import { hash01 } from "./sky";
interface Gene {
  readonly parent: number;
  readonly depth: number;
  /** Radians from straight up, to the right positive. */
  readonly angle: number;
  /** A fraction of the tree's full height. */
  readonly length: number;
  /** The growth (0..1) it starts to grow at; it is full grown 0.14 later. */
  readonly birth: number;
}

const maxDepth = 6;
const unfold = 0.14;

/** A seeded random, so the genome is the same on every load. */
function random(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeGenome(seed: number): Gene[] {
  const rnd = random(seed);
  const genes: Gene[] = [{ parent: -1, depth: 0, angle: 0, length: 0.26, birth: 0 }];
  const grow = (at: number) => {
    const g = genes[at]!;
    if (g.depth >= maxDepth) return;
    // The trunk forks in three, the boughs in two, now and then three.
    const n = g.depth === 0 ? 3 : 2 + (g.depth < 3 && rnd() < 0.35 ? 1 : 0);
    const spread = 0.62 - g.depth * 0.06;
    for (let i = 0; i < n; i++) {
      const side = n === 1 ? 0 : i / (n - 1) - 0.5;
      // Branches lean back towards the sky, so the crown is round rather than a fan.
      const angle = (g.angle + side * spread * 2 + (rnd() - 0.5) * 0.3) * 0.8;
      genes.push({
        parent: at,
        depth: g.depth + 1,
        angle,
        length: g.length * (0.7 + rnd() * 0.12),
        birth: g.birth + (g.depth === 0 ? 0.12 : 0.09 + rnd() * 0.05),
      });
      grow(genes.length - 1);
    }
  };
  grow(0);
  return genes;
}

const genome = makeGenome(20261022);

export interface Segment {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly width: number;
  readonly depth: number;
  /** Nothing grows from its end yet: a bud there. */
  readonly tip: boolean;
}

export interface Placed {
  readonly item: MemoryItem;
  readonly x: number;
  readonly y: number;
}

/** A clump of foliage where leaves gather: as big as the leaves hung there. */
export interface Clump {
  readonly x: number;
  readonly y: number;
  readonly r: number;
}

export interface GrownTree {
  readonly segments: readonly Segment[];
  readonly clumps: readonly Clump[];
  readonly leaves: readonly Placed[];
  readonly fruits: readonly Placed[];
  readonly seeds: readonly Placed[];
  /** The crown's top, for framing. */
  readonly top: number;
}

/** How grown the farm is (0..1) after this many rounds of work: fast at first, slower later, never quite done. */
export function growthOf(rounds: number): number {
  return Math.min(1, 0.06 + 0.94 * (Math.log1p(rounds) / Math.log1p(600)));
}

/**
 * The tree at `growth`, `height` pixels tall when full grown, with the memories written by then. `sway` (radians)
 * bends the tips, the wind.
 */
export function growTree(items: readonly MemoryItem[], growth: number, height: number, sway = 0): GrownTree {
  const ends: { x: number; y: number; angle: number; shown: boolean; tip: boolean }[] = [];
  const segments: Segment[] = [];
  let top = 0;
  genome.forEach((g) => {
    const from = g.parent < 0 ? { x: 0, y: 0, angle: 0, shown: true } : ends[g.parent]!;
    const grown = Math.max(0, Math.min(1, (growth - g.birth) / unfold));
    const shown = from.shown && grown > 0;
    const angle = g.angle + sway * g.depth * 0.25;
    const len = g.length * height * grown;
    const x = from.x + Math.sin(angle) * len;
    const y = from.y + Math.cos(angle) * len;
    ends.push({ x, y, angle, shown, tip: true });
    if (g.parent >= 0 && shown) ends[g.parent]!.tip = false;
    if (!shown) return;
    top = Math.max(top, y);
    segments.push({ x0: from.x, y0: from.y, x1: x, y1: y, width: Math.max(1, (1 + 6 * growth) * Math.pow(0.6, g.depth)), depth: g.depth, tip: true });
    if (g.parent >= 0) {
      const parent = segments.findIndex((s) => s.x1 === from.x && s.y1 === from.y);
      if (parent >= 0) segments[parent] = { ...segments[parent]!, tip: false };
    }
  });
  // Where leaves grow: every bough's end, not the trunk's, so the crown covers the branches; a sprout has only its top.
  const boughs = ends.filter((e, i) => e.shown && genome[i]!.depth >= 1);
  const anchors = boughs.length > 0 ? boughs : ends.filter((e) => e.shown);
  const fruitAnchors = ends.filter((e, i) => e.shown && genome[i]!.depth >= 2 && growth > 0.3);
  const hung = new Map<(typeof anchors)[number], number>();
  const place = (item: MemoryItem, list: typeof anchors, reach: number): Placed | undefined => {
    if (list.length === 0) return undefined;
    const a = list[Math.floor(hash01(item.id) * list.length)]!;
    if (item.kind === "leaf") hung.set(a, (hung.get(a) ?? 0) + 1);
    const r = reach * Math.sqrt(hash01(`${item.id}r`));
    const t = hash01(`${item.id}t`) * Math.PI * 2;
    return { item, x: a.x + Math.cos(t) * r, y: a.y + Math.sin(t) * r * 0.8 };
  };
  const reach = 2 + 5 * growth;
  const leaves: Placed[] = [];
  const fruits: Placed[] = [];
  const seeds: Placed[] = [];
  let seedIndex = 0;
  for (const item of items) {
    if (item.kind === "leaf") {
      const p = place(item, anchors, reach);
      if (p) leaves.push(p);
    } else if (item.kind === "fruit") {
      const p = place(item, fruitAnchors, reach * 0.7);
      if (p) fruits.push(p);
    } else if (growth > 0.5) {
      // Seeds lie between the roots, alternating sides.
      const i = seedIndex++;
      const side = i % 2 === 0 ? 1 : -1;
      seeds.push({ item, x: side * (10 + Math.floor(i / 2) * 7 + growth * 6), y: -3 - (i % 3) });
    }
  }
  const clumps = [...hung].map(([a, n]) => ({ x: a.x, y: a.y, r: (1.5 + Math.sqrt(n) * 2.2) * (0.6 + 0.4 * growth) }));
  return { segments, clumps, leaves, fruits, seeds, top: top + reach + Math.max(0, ...clumps.map((c) => c.r)) };
}
