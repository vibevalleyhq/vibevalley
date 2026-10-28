import { t } from "@vibevalley/i18n";
// The memory tree's one scene, drawn small on a 2D canvas and scaled up whole so it is pixel art like the farm: a
// golden-hour meadow with the tree grown from the memories (grow.ts), and, looking up, the night sky where the same
// memories are stars (rules.ts starsOf). Opening, the tree grows from a sprout to its size; moving the time slider
// grows it back or on. Looking up, the meadow sinks, the sky goes dark and every leaf and fruit rises to its star.

import { onSettled } from "solid-js";
import { reducedMotion } from "../ui/pixel";
import { growthOf, growTree, type GrownTree, type Placed } from "./grow";
import type { MemoryItem, MemoryKind, MemoryTree } from "./mock";
import { constellation, flashFor, hash01, kept, type Star, starsOf, tiesOf, type TreeFilter } from "./rules";

export interface SceneHover {
  readonly item: MemoryItem;
  readonly x: number;
  readonly y: number;
}

/** Where the tree stands, in the page's CSS pixels: it is centred in this box, its foot near the bottom. */
export interface SceneArea {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

type Rgb = readonly [number, number, number];

// Warm, low evening light from the left, like the hill behind (tree-hill.png): olive greens, sunlit edges going gold.
const bark = { line: [52, 32, 22] as Rgb, fill: [104, 66, 40] as Rgb, light: [170, 108, 60] as Rgb };
const leaf = {
  line: [30, 44, 24] as Rgb,
  shade: [56, 80, 36] as Rgb,
  fill: [92, 120, 46] as Rgb,
  light: [158, 162, 62] as Rgb,
  sun: [222, 186, 84] as Rgb,
  dim: [104, 112, 86] as Rgb,
};
const yellow = { fill: [222, 170, 58] as Rgb, light: [246, 210, 110] as Rgb };
const fruit = { line: [112, 52, 20] as Rgb, fill: [240, 156, 52] as Rgb, light: [255, 226, 140] as Rgb };
const starColour: Record<MemoryKind, Rgb> = { seed: [255, 214, 120], fruit: [242, 165, 65], leaf: [214, 240, 200] };

const css = (c: Rgb, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a: Rgb, b: Rgb, k: number): Rgb => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2);

/** A filled pixel disc: one rect per row, so the edge stays hard. */
function disc(c: CanvasRenderingContext2D, x: number, y: number, r: number) {
  const cx = Math.round(x);
  const cy = Math.round(y);
  const rr = Math.max(0, r);
  for (let dy = -Math.floor(rr); dy <= Math.floor(rr); dy++) {
    const half = Math.floor(Math.sqrt(rr * rr - dy * dy) + 0.35);
    c.fillRect(cx - half, cy + dy, half * 2 + 1, 1);
  }
}

/** A line of whole pixels; `gap` 2 dots it. */
function line(c: CanvasRenderingContext2D, x0: number, y0: number, x1: number, y1: number, gap = 1) {
  const steps = Math.max(1, Math.ceil(Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0))));
  for (let i = 0; i <= steps; i += gap) c.fillRect(Math.round(x0 + ((x1 - x0) * i) / steps), Math.round(y0 + ((y1 - y0) * i) / steps), 1, 1);
}

/** A picture from rows of characters: each character a colour from `ink`, a space nothing. */
function pattern(c: CanvasRenderingContext2D, rows: readonly string[], x: number, y: number, ink: Record<string, string>) {
  rows.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const colour = ink[row[dx]!];
      if (!colour) continue;
      c.fillStyle = colour;
      c.fillRect(Math.round(x) + dx, Math.round(y) + dy, 1, 1);
    }
  });
}

/** The backdrop's size, and where on it the knoll the tree grows on is, as fractions. */
const backdropSize = { w: 384, h: 256 };
const knoll = { x: 0.36, y: 0.71 };

const fruitRows = [" ooo ", "offfo", "ohffo", "offfo", " ooo "];
const sackRows = ["  g  ", " sgs ", "sssss", "sSsss", "sssSs", " sss "];

export function Scene(props: {
  tree: MemoryTree;
  filter: TreeFilter;
  /** 0..1 from the first memory to now: the tree as it was then, the stars out by then. */
  until: number;
  sky: boolean;
  area: SceneArea;
  onHover: (hover: SceneHover | null) => void;
  onPick: (item: MemoryItem) => void;
}) {
  let canvas!: HTMLCanvasElement;
  const still = reducedMotion();

  onSettled(() => {
    const ctx = canvas.getContext("2d")!;
    const low = document.createElement("canvas");
    const lc = low.getContext("2d")!;
    const layer = document.createElement("canvas");
    const tc = layer.getContext("2d")!;
    const now = Date.now();
    const stars = starsOf(props.tree, now);
    const starOf = new Map<string, Star>(stars.map((s) => [s.item.id, s]));
    const dust = Array.from({ length: 180 }, (_, i) => [hash01(`dx${i}`), hash01(`dy${i}`), hash01(`db${i}`)] as const);
    let px = 3;
    let growth = 0.02;
    let night = props.sky ? 1 : 0;
    let angle = 0.6;
    let tilt = 0.5;
    let drag: { x: number; y: number; angle: number; tilt: number; moved: boolean } | undefined;
    let grown: GrownTree | undefined;
    let layerKey = "";
    let hits: { x: number; y: number; r: number; item: MemoryItem }[] = [];
    let hovered: string | undefined;
    /** The hovered memory's constellation and what it is recalled with: lit, the rest dimmed. */
    let lit: Set<string> | undefined;
    const light = (id: string | undefined) => {
      if (id === undefined) return (lit = undefined);
      const ties = tiesOf(props.tree.links, id);
      lit = constellation(props.tree.links, id);
      for (const t of ties.together) lit.add(t.id);
    };

    // The hill above the valley, by day and by night (design/pixel gen.sh tree-hill): drawn into the scene at one of its
    // pixels to one of the scene's, so the tree drawn in code sits on the same grid. Until they load, the sky's colour.
    const backdrop = { day: new Image(), night: new Image(), up: new Image() };
    const sky = { day: [232, 176, 150] as Rgb, night: [10, 14, 34] as Rgb };
    const topColour = (img: HTMLImageElement): Rgb => {
      const c = document.createElement("canvas").getContext("2d")!;
      c.drawImage(img, 0, 0);
      const [r, g, b] = c.getImageData(backdropSize.w / 2, 0, 1, 1).data;
      return [r!, g!, b!];
    };
    backdrop.day.onload = () => (sky.day = topColour(backdrop.day));
    backdrop.night.onload = () => (sky.night = topColour(backdrop.night));
    backdrop.day.src = "/pixel/tree-hill.png";
    backdrop.night.src = "/pixel/tree-hill-night.png";
    backdrop.up.src = "/pixel/tree-sky.png";
    /** Where the backdrop's top left is in the scene; the knoll is under the tree's foot when it can be. */
    let offset = { x: 0, y: 0 };

    const narrow = () => canvas.clientWidth < 760;
    const fit = () => {
      // Scene pixels as big as the backdrop's, covering the page; on a narrow page the backdrop fills the part above the
      // panel.
      px = Math.max(canvas.clientWidth / backdropSize.w, (canvas.clientHeight * (narrow() ? 0.56 : 1)) / backdropSize.h);
      low.width = layer.width = Math.max(1, Math.ceil(canvas.clientWidth / px));
      low.height = layer.height = Math.max(1, Math.ceil(canvas.clientHeight / px));
      canvas.width = Math.round(low.width * px);
      canvas.height = Math.round(low.height * px);
      layerKey = "";
    };
    fit();
    const resized = new ResizeObserver(fit);
    resized.observe(canvas);

    const cutoff = () => props.tree.since + props.until * (now - props.tree.since);
    const written = () => props.tree.items.filter((m) => m.at <= cutoff());
    /** The rounds by then: the total, in the share of memories written by then. */
    const target = () => growthOf((props.tree.rounds * written().length) / Math.max(1, props.tree.items.length));

    /** The tree's foot (on the knoll) and its full height, in scene pixels. */
    const frame = () => {
      const a = props.area;
      const want = (a.x + a.w / 2) / px;
      offset = {
        x: Math.round(Math.min(0, Math.max(low.width - backdropSize.w, want - knoll.x * backdropSize.w))),
        y: narrow() ? 0 : low.height - backdropSize.h,
      };
      return {
        x: Math.round(offset.x + knoll.x * backdropSize.w),
        y: Math.round(offset.y + knoll.y * backdropSize.h),
        height: Math.min((a.h * 0.46) / px, (a.w * 0.56) / px),
      };
    };

    const ready = (img: HTMLImageElement) => img.complete && img.naturalWidth > 0;
    /** How far the view has turned up to the sky (0..1): the second half of the night coming. */
    const upOf = (k: number) => ease(Math.max(0, Math.min(1, k * 2 - 1)));
    /** How far the hill has sunk out of view as the view turns up, in scene pixels. */
    const liftOf = (k: number) => Math.round(upOf(k) * low.height * 0.6);

    /**
     * The night (`k`) coming over the hill: in its first half the day picture turns to the night one; in its second the
     * view turns up, the hill sinking away and the sky seen looking up (tree-sky.png) coming down from above.
     */
    const drawBackdrop = (k: number) => {
      const dusk = Math.min(1, k * 2);
      const up = upOf(k);
      lc.fillStyle = css(mix(sky.day, sky.night, dusk));
      lc.fillRect(0, 0, low.width, low.height);
      const x = offset.x;
      const y = offset.y + liftOf(k);
      if (up < 1) {
        if (ready(backdrop.day)) lc.drawImage(backdrop.day, x, y);
        if (dusk > 0 && ready(backdrop.night)) {
          lc.globalAlpha = dusk;
          lc.drawImage(backdrop.night, x, y);
          lc.globalAlpha = 1;
        }
        // Below the backdrop on a narrow page: its bottom row's grass, under the panel.
        if (y + backdropSize.h < low.height) {
          lc.fillStyle = css(mix([76, 110, 50], [10, 18, 16], dusk));
          lc.fillRect(0, y + backdropSize.h, low.width, low.height - y - backdropSize.h);
        }
      }
      if (up > 0 && ready(backdrop.up)) {
        lc.globalAlpha = up;
        lc.drawImage(backdrop.up, Math.round((low.width - backdropSize.w) / 2), Math.round(low.height - backdropSize.h - (1 - up) * low.height * 0.4));
        lc.globalAlpha = 1;
      }
    };

    const drawTree = (c: CanvasRenderingContext2D, t: GrownTree, bx: number, by: number) => {
      const filtering = props.filter.agent !== "" || props.filter.project !== "";
      // The crown's shadow on the grass, dithered, as wide as the crown.
      const spread = t.clumps.length > 0 ? Math.max(...t.clumps.map((k) => Math.abs(k.x) + k.r)) : 6;
      c.fillStyle = "rgba(30,52,24,0.35)";
      for (let dy = -4; dy <= 4; dy++) {
        const half = Math.floor(spread * 0.8 * Math.sqrt(1 - (dy / 5) ** 2));
        for (let dx = -half; dx <= half; dx++) if ((dx + dy) % 2 === 0) c.fillRect(bx + dx + 4, by + dy + 1, 1, 1);
      }
      // Roots spreading over the ground, longer and thicker as the tree grows.
      if (growth > 0.15) {
        const trunk = t.segments[0]?.width ?? 1;
        for (const [side, reach, drop] of [
          [-1, 1, 2],
          [1, 0.9, 3],
          [-1, 0.55, 4],
          [1, 0.6, 1],
        ] as const) {
          const len = (6 + growth * 26) * reach;
          for (const pass of ["line", "fill"] as const) {
            c.fillStyle = css(bark[pass]);
            for (let i = 0; i <= len; i++) {
              const d = i / len;
              disc(c, bx + side * (trunk * 0.3 + i), by - 1 + d * drop, Math.max(0.6, (trunk / 2) * Math.pow(1 - d, 1.4) * 1.1) + (pass === "line" ? 1 : 0));
            }
          }
        }
      }
      // Leaves that let go lie on the grass under the crown, as many as are fading.
      c.fillStyle = css(yellow.fill);
      for (const l of t.leaves) {
        if (!l.item.fading) continue;
        for (let j = 0; j < 2; j++) {
          const x = bx + (hash01(`${l.item.id}f${j}`) - 0.5) * spread * 1.4;
          const y = by + 1 + hash01(`${l.item.id}g${j}`) * 5;
          c.fillRect(Math.round(x), Math.round(y), 2, 1);
        }
      }
      // The branches: an outline pass under a fill pass, the light from the upper left.
      for (const pass of ["line", "fill", "light"] as const) {
        c.fillStyle = css(bark[pass]);
        for (const s of t.segments) {
          const steps = Math.max(1, Math.ceil(Math.hypot(s.x1 - s.x0, s.y1 - s.y0)));
          const r = s.width / 2 + (pass === "line" ? 1 : 0) - (pass === "light" ? Math.max(0.6, s.width * 0.3) : 0);
          if (pass === "light" && s.width < 2.5) continue;
          for (let i = 0; i <= steps; i++) {
            const x = bx + s.x0 + ((s.x1 - s.x0) * i) / steps - (pass === "light" ? s.width * 0.18 : 0);
            const y = by - (s.y0 + ((s.y1 - s.y0) * i) / steps);
            disc(c, x, y, r);
          }
        }
      }
      // A bud on every branch's end, so a young tree with few memories still looks alive.
      for (const s of t.segments) {
        if (!s.tip || (s.depth === 0 && t.segments.length > 1)) continue;
        c.fillStyle = css(leaf.line);
        disc(c, bx + s.x1, by - s.y1, 2.2);
        c.fillStyle = css(leaf.light);
        disc(c, bx + s.x1, by - s.y1, 1.2);
      }
      const r = 1.5 + growth * 1.5;
      const on = (m: MemoryItem) => !filtering || kept(m, props.filter);
      // The crown: a clump wherever leaves gather, as big as their number, and on it every leaf memory a small disc.
      // Outlines first, so the clumps merge into one crown.
      c.fillStyle = css(leaf.line);
      for (const k of t.clumps) disc(c, bx + k.x, by - k.y, k.r + 1);
      for (const l of t.leaves) disc(c, bx + l.x, by - l.y, r + 1);
      c.fillStyle = css(leaf.shade);
      for (const k of t.clumps) disc(c, bx + k.x, by - k.y, k.r);
      c.fillStyle = css(leaf.fill);
      for (const k of t.clumps) disc(c, bx + k.x - k.r * 0.25, by - k.y - k.r * 0.3, k.r * 0.7);
      // Leafy speckles in each clump, and the low sun catching the crown's left edges.
      for (const k of t.clumps) {
        const n = Math.round(k.r * k.r * 0.35);
        for (let i = 0; i < n; i++) {
          const a = hash01(`${k.x},${k.y},${i}a`) * Math.PI * 2;
          const d = Math.sqrt(hash01(`${k.x},${k.y},${i}d`)) * k.r * 0.9;
          const x = bx + k.x + Math.cos(a) * d;
          const y = by - k.y + Math.sin(a) * d;
          c.fillStyle = css(Math.cos(a) < -0.2 && Math.sin(a) < 0.3 ? leaf.light : leaf.shade);
          c.fillRect(Math.round(x), Math.round(y), 1, 1);
        }
        c.fillStyle = css(leaf.sun);
        for (let i = 0; i < 6; i++) {
          const a = Math.PI * (0.85 + i * 0.07);
          c.fillRect(Math.round(bx + k.x + Math.cos(a) * k.r), Math.round(by - k.y - Math.sin(a) * k.r * 0.9), 1, 1);
        }
      }
      for (const l of t.leaves) {
        c.fillStyle = css(l.item.fading ? yellow.fill : on(l.item) ? leaf.fill : leaf.dim);
        disc(c, bx + l.x, by - l.y, r);
      }
      for (const l of t.leaves) {
        if (hash01(`${l.item.id}h`) < 0.45) continue;
        c.fillStyle = css(l.item.fading ? yellow.light : on(l.item) ? leaf.light : leaf.dim);
        disc(c, bx + l.x - 1, by - l.y - 1, r - 1.2);
      }
      for (const f of t.fruits) {
        const dim = on(f.item) ? 1 : 0.35;
        pattern(c, fruitRows, bx + f.x - 2, by - f.y - 2, { o: css(fruit.line, dim), f: css(fruit.fill, dim), h: css(fruit.light, dim) });
      }
      for (const s of t.seeds) {
        const dim = on(s.item) ? 1 : 0.35;
        pattern(c, sackRows, bx + s.x - 2, by - s.y - 6, { s: css([196, 156, 98], dim), S: css([150, 112, 66], dim), g: css([244, 196, 70], dim) });
      }
    };

    const project = (s: Star, t: number) => {
      const w = low.width;
      const h = low.height;
      const radius = Math.min(w * 0.4, (h * 0.32) / Math.max(0.3, Math.sin(tilt)));
      const drift = s.item.fading ? 1 + 0.06 * (1 + Math.sin(t / 1400 + hash01(s.item.id) * 6)) : 1;
      const x = s.x * drift;
      const z = s.z * drift;
      const rx = x * Math.cos(angle) - z * Math.sin(angle);
      const rz = x * Math.sin(angle) + z * Math.cos(angle);
      const ty = s.y * Math.cos(tilt) - rz * Math.sin(tilt);
      const tz = s.y * Math.sin(tilt) + rz * Math.cos(tilt);
      const k = 2.4 / (2.4 + tz);
      return { x: w / 2 + rx * radius * k, y: h * (0.38 + 0.06 * upOf(night)) + ty * radius * k, depth: tz };
    };

    const draw = (t: number) => {
      const w = low.width;
      const h = low.height;
      const f = frame();
      const k = ease(night);
      // The hill stays; the night falls over it and the tree fades into its stars.
      drawBackdrop(k);
      if (k > 0) {
        lc.fillStyle = `rgba(4,6,18,${0.4 * Math.min(1, k * 2) * (1 - upOf(k) * 0.6)})`;
        lc.fillRect(0, 0, w, h);
        for (const [x, y, b] of dust) {
          lc.fillStyle = `rgba(190,205,255,${(b * 0.5 + 0.15) * (0.35 + 0.35 * Math.sin(t / 900 + b * 40)) * k})`;
          lc.fillRect(Math.floor(x * w), Math.floor(y * h), 1, 1);
        }
      }
      const key = `${growth.toFixed(3)}|${props.filter.agent}|${props.filter.project}|${props.until}|${w}x${h}|${f.x},${f.y},${f.height}`;
      if (key !== layerKey) {
        layerKey = key;
        grown = growTree(written(), growth, f.height);
        tc.clearRect(0, 0, w, h);
        drawTree(tc, grown, f.x, f.y);
      }
      const tree = grown!;
      hits = [];
      if (k < 1) {
        lc.globalAlpha = 1 - k;
        lc.drawImage(layer, 0, liftOf(k));
        lc.globalAlpha = 1;
        // Where a memory on the tree is in the scene this frame.
        const footX = f.x;
        const footY = f.y + liftOf(k);
        const at = (p: Placed) => ({ x: footX + p.x, y: footY - p.y });
        // A fading leaf lets go, sways down to the grass and starts again.
        for (const l of tree.leaves) {
          if (!l.item.fading || still()) continue;
          const phase = (t / 6500 + hash01(l.item.id)) % 1;
          const p = at(l);
          const y = p.y + phase * (f.y - p.y);
          const x = p.x + Math.sin(phase * 9) * 4 + phase * 6;
          lc.fillStyle = css(yellow.fill, phase > 0.9 ? (1 - phase) * 10 : 1);
          lc.fillRect(Math.round(x), Math.round(y), 2, 1);
          lc.fillRect(Math.round(x) + ((phase * 9) % 2 > 1 ? 1 : 0), Math.round(y) + 1, 1, 1);
        }
        for (const p of tree.fruits) {
          const s = at(p);
          if (p.item.recalledAt !== undefined && now - p.item.recalledAt < flashFor && Math.floor(t / 400) % 2 === 0) {
            lc.fillStyle = "rgba(255,255,240,0.95)";
            lc.fillRect(Math.round(s.x) - 4, Math.round(s.y), 9, 1);
            lc.fillRect(Math.round(s.x), Math.round(s.y) - 4, 1, 9);
          }
          hits.push({ ...s, r: 3.5, item: p.item });
        }
        for (const p of tree.seeds) {
          const s = at(p);
          if (!p.item.sown && Math.floor(t / 600 + hash01(p.item.id) * 4) % 3 === 0) {
            lc.fillStyle = "rgba(255,236,150,0.9)";
            lc.fillRect(Math.round(s.x), Math.round(s.y) - 8, 1, 1);
          }
          hits.push({ x: s.x, y: s.y - 3, r: 4, item: p.item });
        }
        for (const p of tree.leaves) hits.push({ ...at(p), r: 2.5, item: p.item });
        const hover = hits.find((x) => x.item.id === hovered);
        if (hover) {
          // Threads on the tree: gold to what it grew from and what grew from it, pale blue to what it is recalled with.
          const ties = tiesOf(props.tree.links, hover.item.id);
          const where = new Map(hits.map((x) => [x.item.id, x]));
          lc.fillStyle = "rgba(255,226,140,0.95)";
          for (const id of [...ties.from, ...ties.grew]) {
            const to = where.get(id);
            if (to) line(lc, hover.x, hover.y, to.x, to.y, 2);
          }
          lc.fillStyle = "rgba(190,215,255,0.85)";
          for (const t of ties.together) {
            const to = where.get(t.id);
            if (to) line(lc, hover.x, hover.y, to.x, to.y, 3);
          }
          lc.fillStyle = "rgba(255,248,220,0.9)";
          const r = Math.ceil(hover.r) + 1;
          lc.fillRect(Math.round(hover.x) - r, Math.round(hover.y) - r, 1, 1);
          lc.fillRect(Math.round(hover.x) + r, Math.round(hover.y) - r, 1, 1);
          lc.fillRect(Math.round(hover.x) - r, Math.round(hover.y) + r, 1, 1);
          lc.fillRect(Math.round(hover.x) + r, Math.round(hover.y) + r, 1, 1);
        }
      }
      if (k < 1) {
        // Two butterflies over the meadow by day.
        for (let i = 0; i < 2; i++) {
          const x = ((t / (60 + i * 25) + i * 170) % (w + 40)) - 20;
          const y = f.y - 20 - i * 14 + Math.sin(t / 380 + i) * 6;
          const up = Math.floor(t / 140 + i) % 2 === 0;
          lc.fillStyle = css(i === 0 ? [250, 246, 230] : [246, 206, 74], 1 - k);
          lc.fillRect(Math.round(x) - 1, Math.round(y) - (up ? 1 : 0), 1, up ? 2 : 1);
          lc.fillRect(Math.round(x) + 1, Math.round(y) - (up ? 1 : 0), 1, up ? 2 : 1);
          lc.fillStyle = css([60, 44, 30], 1 - k);
          lc.fillRect(Math.round(x), Math.round(y), 1, 1);
        }
      }
      if (k > 0) {
        // The stars, each risen from where its memory hangs on the tree.
        const from = new Map<string, { x: number; y: number }>();
        for (const p of [...tree.leaves, ...tree.fruits, ...tree.seeds]) from.set(p.item.id, { x: f.x + p.x, y: f.y - p.y + liftOf(k) });
        const placed = written()
          .map((item) => {
            const s = starOf.get(item.id)!;
            const to = project(s, t);
            const start = from.get(item.id) ?? { x: f.x, y: f.y };
            const kk = Math.min(1, Math.max(0, k * 1.25 - hash01(`${item.id}d`) * 0.25));
            return { s, x: start.x + (to.x - start.x) * kk, y: start.y + (to.y - start.y) * kk, depth: to.depth };
          })
          .sort((a, b) => b.depth - a.depth);
        // The disc's own faint light and its rings (time, the older farther out), so its shape reads first.
        const ring = (r: number, step: number, fill: boolean) => {
          if (fill) lc.beginPath();
          for (let i = 0; i <= 96; i += step) {
            const a = (i / 96) * Math.PI * 2;
            const p = project({ item: props.tree.items[0]!, x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r, size: 0 }, t);
            if (!fill) lc.fillRect(Math.floor(p.x), Math.floor(p.y), 1, 1);
            else if (i === 0) lc.moveTo(p.x, p.y);
            else lc.lineTo(p.x, p.y);
          }
          if (fill) lc.fill();
        };
        for (let r = 1; r > 0.05; r -= 0.05) {
          lc.fillStyle = `rgba(120,150,210,${(0.018 + (1 - r) * 0.02) * k})`;
          ring(r, 2, true);
        }
        lc.fillStyle = `rgba(170,200,255,${0.1 * k})`;
        for (const r of [0.25, 0.5, 0.75, 1]) ring(r, 2, false);
        const sun = project({ item: placed[0]?.s.item ?? props.tree.items[0]!, x: 0, y: 0, z: 0, size: 0 }, t);
        for (let r = 9; r >= 1; r--) {
          lc.fillStyle = `rgba(255,${190 + r * 4},110,${(0.05 + (9 - r) * 0.02) * k})`;
          disc(lc, sun.x, sun.y, r);
        }
        // The constellations: gold where one memory grew from another, pale blue where two are recalled together. Faint
        // until a star is hovered; then its own are bright and the rest fainter still.
        const pos = new Map(placed.map((p) => [p.s.item.id, p]));
        for (const l of props.tree.links) {
          const a = pos.get(l.a);
          const b = pos.get(l.b);
          if (!a || !b || !kept(a.s.item, props.filter) || !kept(b.s.item, props.filter)) continue;
          const direct = l.a === hovered || l.b === hovered;
          const mine = lit?.has(l.a) && lit.has(l.b) && (l.kind === "from" || direct);
          const base = l.kind === "from" ? 0.16 : 0.1;
          const alpha = (lit ? (mine ? (direct ? 0.9 : 0.55) : base * 0.4) : base) * k;
          lc.fillStyle = l.kind === "from" ? `rgba(255,214,130,${alpha})` : `rgba(160,190,255,${alpha})`;
          line(lc, a.x, a.y, b.x, b.y, mine && direct ? 1 : 2);
        }
        for (const p of placed) {
          const { item, size } = p.s;
          const on = kept(item, props.filter);
          const flash = item.recalledAt !== undefined && now - item.recalledAt < flashFor && Math.floor(t / 400) % 2 === 0;
          const near = 1 - Math.max(0, Math.min(1, (p.depth + 1) / 2)) * 0.35;
          const alpha = (on ? 1 : 0.2) * near * (item.fading ? 0.45 : 1) * Math.min(1, k * 1.5) * (lit && !lit.has(item.id) ? 0.35 : 1);
          lc.fillStyle = css(flash ? [255, 255, 255] : starColour[item.kind], alpha);
          const x = Math.floor(p.x);
          const y = Math.floor(p.y);
          if (size >= 3) {
            lc.fillRect(x - 1, y, 3, 1);
            lc.fillRect(x, y - 1, 1, 3);
            if (flash || lit?.has(item.id)) {
              lc.fillRect(x - 2, y, 5, 1);
              lc.fillRect(x, y - 2, 1, 5);
            }
          } else {
            lc.fillRect(x, y, size, size);
            if (size === 2 && on) {
              lc.fillStyle = css(starColour[item.kind], alpha * 0.25);
              lc.fillRect(x - 1, y - 1, 4, 4);
            }
          }
          if (on && k === 1) hits.push({ x: p.x, y: p.y, r: item.kind === "leaf" ? 2 : 3.5, item });
        }
      }
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(low, 0, 0, canvas.width, canvas.height);
    };

    let last = performance.now();
    let id = requestAnimationFrame(function tick(t) {
      const dt = Math.min(64, t - last);
      last = t;
      // Grow towards the size the farm had by the slider's day: quickly at first, easing in.
      const goal = target();
      growth = still() ? goal : growth + (goal - growth) * Math.min(1, dt / 520);
      if (Math.abs(goal - growth) < 0.001) growth = goal;
      const want = props.sky ? 1 : 0;
      night = still() ? want : night + Math.sign(want - night) * Math.min(Math.abs(want - night), dt / 1400);
      if (props.sky && !drag && !still()) angle += dt * 0.00005;
      draw(t);
      id = requestAnimationFrame(tick);
    });

    const at = (e: PointerEvent) => {
      const box = canvas.getBoundingClientRect();
      return { x: (e.clientX - box.left) / px, y: (e.clientY - box.top) / px };
    };
    const hitAt = (e: PointerEvent) => {
      const p = at(e);
      let best: (typeof hits)[number] | undefined;
      let bestD = Infinity;
      for (const h of hits) {
        // A leaf is small and many: a fruit, a seed or a star under the pointer wins over it.
        const d = Math.hypot(h.x - p.x, h.y - p.y) - h.r + (h.item.kind === "leaf" ? 1 : 0);
        if (d < 0.5 && d < bestD) {
          bestD = d;
          best = h;
        }
      }
      return best;
    };
    const down = (e: PointerEvent) => {
      drag = { x: e.clientX, y: e.clientY, angle, tilt, moved: false };
      canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (drag && props.sky) {
        if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > 4) drag.moved = true;
        angle = drag.angle + (e.clientX - drag.x) * 0.006;
        tilt = Math.max(0.2, Math.min(1.45, drag.tilt + (e.clientY - drag.y) * 0.004));
        return;
      }
      const best = hitAt(e);
      canvas.style.cursor = best ? "pointer" : props.sky ? "grab" : "default";
      if (best?.item.id === hovered) return;
      hovered = best?.item.id;
      light(props.sky ? hovered : undefined);
      props.onHover(best ? { item: best.item, x: e.clientX, y: e.clientY } : null);
    };
    const up = (e: PointerEvent) => {
      const moved = drag?.moved;
      drag = undefined;
      if (moved) return;
      const best = hitAt(e);
      if (best) props.onPick(best.item);
    };
    const leave = () => {
      hovered = undefined;
      lit = undefined;
      props.onHover(null);
    };
    canvas.addEventListener("pointerdown", down);
    canvas.addEventListener("pointermove", move);
    canvas.addEventListener("pointerup", up);
    canvas.addEventListener("pointerleave", leave);
    return () => {
      cancelAnimationFrame(id);
      resized.disconnect();
      canvas.removeEventListener("pointerdown", down);
      canvas.removeEventListener("pointermove", move);
      canvas.removeEventListener("pointerup", up);
      canvas.removeEventListener("pointerleave", leave);
    };
  });

  return (
    <canvas
      ref={(el) => (canvas = el)}
      role="img"
      aria-label={t("web.tree.scene")}
      data-testid="memory-scene"
      class="absolute inset-0 block size-full touch-none [image-rendering:pixelated]"
    />
  );
}
