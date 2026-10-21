// Small things that fly, fall, drift and fade: dust, sparks, smoke, leaves, drops, hearts; and rings that widen and
// fade (ripples, radio waves, where a click landed). A scene adds them where something happens and steps them once
// a frame. Positions round to whole pixels and fading goes in steps, so it stays pixel art. Little pictures are
// drawn from rows of '#' (`glyph`).

import { Container, Graphics } from "pixi.js";

export interface BitSpec {
  readonly x: number;
  readonly y: number;
  /** Seconds before it is gone. */
  readonly life: number;
  readonly vx?: number;
  readonly vy?: number;
  /** Pull down, pixels per second squared (negative floats it up). */
  readonly fall?: number;
  /** How much the wind carries it. */
  readonly drift?: number;
  /** How far it swings side to side, as a leaf or a sheet of paper does. */
  readonly sway?: number;
  /** How much it grows each second (smoke, a puff of dust). */
  readonly grow?: number;
  /** How opaque it starts. */
  readonly alpha?: number;
}

export interface RingSpec {
  readonly x: number;
  readonly y: number;
  readonly from: number;
  readonly to: number;
  /** Height over width: flat on water, 1 in the air. */
  readonly squash: number;
  readonly color: number;
  readonly life: number;
}

export interface Particles {
  /** Puts `node` on `layer` and moves it as `spec` says until its life is over. */
  readonly add: (layer: Container, node: Container, spec: BitSpec) => void;
  readonly ring: (layer: Container, spec: RingSpec) => void;
  /** Moves everything on by `dt` seconds; `wind` (0..1) carries what drifts. */
  readonly step: (dt: number, wind?: number) => void;
  /** How many are moving now. */
  readonly count: () => number;
}

/** Steps of fading: a quarter at a time. */
const STEPS = 4;
/** Pixels per second the wind gives a drift of 1 at full strength. */
const WIND = 2;

interface Bit {
  readonly node: Container;
  x: number;
  y: number;
  vx: number;
  vy: number;
  readonly fall: number;
  readonly drift: number;
  readonly sway: number;
  readonly grow: number;
  readonly alpha: number;
  readonly phase: number;
  age: number;
  readonly life: number;
}

interface Ring extends RingSpec {
  readonly g: Graphics;
  age: number;
}

export function particles(): Particles {
  const bits: Bit[] = [];
  const rings: Ring[] = [];
  return {
    add: (layer, node, s) => {
      layer.addChild(node);
      node.position.set(Math.round(s.x), Math.round(s.y));
      bits.push({
        node,
        x: s.x,
        y: s.y,
        vx: s.vx ?? 0,
        vy: s.vy ?? 0,
        fall: s.fall ?? 0,
        drift: s.drift ?? 0,
        sway: s.sway ?? 0,
        grow: s.grow ?? 0,
        alpha: s.alpha ?? 1,
        phase: Math.random() * 6,
        age: 0,
        life: s.life,
      });
    },
    ring: (layer, s) => {
      const g = new Graphics();
      layer.addChild(g);
      rings.push({ ...s, g, age: 0 });
    },
    step: (dt, wind = 0) => {
      for (let i = bits.length - 1; i >= 0; i--) {
        const b = bits[i];
        if (!b) continue;
        b.age += dt;
        if (b.age >= b.life) {
          b.node.destroy({ children: true });
          bits.splice(i, 1);
          continue;
        }
        b.vy += b.fall * dt;
        b.x += (b.vx + wind * b.drift * WIND) * dt;
        b.y += b.vy * dt;
        const swing = b.sway ? Math.sin(b.age * 3 + b.phase) * b.sway : 0;
        b.node.position.set(Math.round(b.x + swing), Math.round(b.y));
        if (b.grow) b.node.scale.set(1 + b.grow * b.age);
        b.node.alpha = b.alpha * (Math.ceil((1 - b.age / b.life) * STEPS) / STEPS);
      }
      for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i];
        if (!r) continue;
        r.age += dt;
        if (r.age >= r.life) {
          r.g.destroy();
          rings.splice(i, 1);
          continue;
        }
        const k = r.age / r.life;
        const radius = Math.round(r.from + (r.to - r.from) * k);
        r.g
          .clear()
          .ellipse(Math.round(r.x), Math.round(r.y), radius, Math.max(1, Math.round(radius * r.squash)))
          .stroke({ width: 1, color: r.color, alpha: Math.ceil((1 - k) * 3) / 3, pixelLine: true });
      }
    },
    count: () => bits.length + rings.length,
  };
}

/** A little picture in pixels, one row per string: '#' is painted, anything else is not. */
export function glyph(rows: readonly string[], color: number): Graphics {
  const g = new Graphics();
  rows.forEach((row, y) => [...row].forEach((c, x) => c === "#" && g.rect(x, y, 1, 1)));
  return g.fill(color);
}

/** One square pixel (or `size` pixels square). */
export const dot = (color: number, size = 1) => new Graphics().rect(0, 0, size, size).fill(color);
