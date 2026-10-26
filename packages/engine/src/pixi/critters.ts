// Little animals that keep a scene alive, as behaviours: flutterers (butterflies) wander about a home and rest now
// and then; a flock (birds) crosses the scene in a loose V, each with its shadow on the ground below; blinkers
// (fireflies) drift about a home and blink, each a small light. Their pictures are two frames that flap (glyph
// rows, or pictures tinted by the critter's colour: draw them white to take it); what they look like and where they
// live is the game's. Positions are whole pixels.

import { Container, Sprite, Texture } from "pixi.js";
import type { Point } from "../nav";
import type { PointLight } from "./light";
import { glyph } from "./particles";

/** One frame: glyph rows ('#' a pixel), or a picture, centred on where the critter is. */
export type FlapFrame = readonly string[] | Texture;

/** Two frames that alternate: wings up, wings down. */
export type Flap = readonly [FlapFrame, FlapFrame];

const frameOf = (frame: FlapFrame, color: number): Container => {
  if (!(frame instanceof Texture)) return glyph(frame, color);
  const picture = new Sprite(frame);
  picture.anchor.set(0.5);
  picture.tint = color;
  return picture;
};

/** A picture of two frames, showing one. */
function flapper(frames: Flap, color: number) {
  const node = new Container();
  const up = frameOf(frames[0], color);
  const down = frameOf(frames[1], color);
  node.addChild(up, down);
  return {
    node,
    show: (open: boolean) => {
      up.visible = open;
      down.visible = !open;
    },
  };
}

export interface FluttererOptions {
  /** Where each one lives: one per home. */
  readonly homes: readonly Point[];
  readonly colors: readonly number[];
  readonly frames: Flap;
  /** How far from home it strays, pixels. */
  readonly range?: number;
  /** Pixels per second. */
  readonly speed?: number;
}

export interface Flutterers {
  /** Moves them on; `shown` (0..1) fades them in and out (by day, by night). */
  readonly update: (t: number, dt: number, shown: number) => void;
}

export function flutterers(layer: Container, { homes, colors, frames, range = 24, speed = 14 }: FluttererOptions): Flutterers {
  const all = homes.map((home, i) => {
    const f = flapper(frames, colors[i % colors.length] ?? 0xffffff);
    layer.addChild(f.node);
    return { ...f, home, x: home.x, y: home.y, heading: Math.random() * Math.PI * 2, restUntil: 0, phase: Math.random() * 6 };
  });
  return {
    update: (t, dt, shown) => {
      for (const b of all) {
        b.node.visible = shown > 0.05;
        if (!b.node.visible) continue;
        b.node.alpha = Math.min(1, shown * 1.5);
        const resting = t < b.restUntil;
        if (!resting) {
          b.heading += (Math.random() - 0.5) * dt * 6;
          if (Math.hypot(b.home.x - b.x, b.home.y - b.y) > range) b.heading = Math.atan2(b.home.y - b.y, b.home.x - b.x);
          b.x += Math.cos(b.heading) * speed * dt;
          b.y += Math.sin(b.heading) * speed * 0.65 * dt + Math.sin(t * 9 + b.phase) * 4 * dt;
          if (Math.random() < dt * 0.15) b.restUntil = t + 1.5 + Math.random() * 2;
        }
        // Resting, the wings open now and then; flying, they beat.
        b.show(resting ? Math.floor((t + b.phase) * 1.5) % 3 === 0 : Math.floor((t + b.phase) * 10) % 2 === 0);
        b.node.position.set(Math.round(b.x), Math.round(b.y - (resting ? 0 : 4)));
      }
    },
  };
}

export interface FlockOptions {
  readonly frames: Flap;
  readonly color: number;
  /** The shadow each one casts on the ground, and how far below it falls. */
  readonly shadow: Texture;
  readonly drop: number;
  /** The scene's width: they fly in from one side and out the other. */
  readonly width: number;
  /** The band of heights they fly at. */
  readonly heights: readonly [number, number];
}

export interface Flocks {
  /** Sends a flock over; `shadow` (0..1) is how dark their shadows are. */
  readonly launch: (shadow: number) => void;
  readonly update: (t: number, dt: number) => void;
}

export function flocks(layer: Container, o: FlockOptions): Flocks {
  const birds: { node: Container; show: (open: boolean) => void; shadow: Sprite; x: number; y: number; speed: number; phase: number }[] = [];
  return {
    launch: (shadowAlpha) => {
      const leftward = Math.random() < 0.5;
      const y = o.heights[0] + Math.random() * (o.heights[1] - o.heights[0]);
      const speed = 60 + Math.random() * 25;
      const n = 2 + Math.floor(Math.random() * 3);
      for (let i = 0; i < n; i++) {
        const f = flapper(o.frames, o.color);
        const shadow = new Sprite(o.shadow);
        shadow.anchor.set(0.5);
        shadow.alpha = shadowAlpha;
        layer.addChild(shadow, f.node);
        // A loose V behind the first.
        const back = Math.ceil(i / 2) * 9;
        const side = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * 5;
        birds.push({ ...f, shadow, x: leftward ? o.width + 10 + back : -10 - back, y: y + side, speed: leftward ? -speed : speed, phase: Math.random() * 6 });
      }
    },
    update: (t, dt) => {
      for (let i = birds.length - 1; i >= 0; i--) {
        const b = birds[i];
        if (!b) continue;
        b.x += b.speed * dt;
        b.show(Math.floor((t + b.phase) * 7) % 2 === 0);
        b.node.position.set(Math.round(b.x), Math.round(b.y + Math.sin(t * 2 + b.phase)));
        b.node.scale.x = b.speed < 0 ? -1 : 1;
        b.shadow.position.set(Math.round(b.x + 10), Math.round(b.y + o.drop));
        if (b.x < -40 || b.x > o.width + 40) {
          b.node.destroy({ children: true });
          b.shadow.destroy();
          birds.splice(i, 1);
        }
      }
    },
  };
}

export interface BlinkerOptions {
  readonly homes: readonly Point[];
  readonly color: number;
  /** The soft glow around each one. */
  readonly halo: Texture;
  /** The light each one gives while lit. */
  readonly light: Pick<PointLight, "z" | "radius" | "color" | "intensity">;
}

export interface Blinkers {
  /** Moves them on; `shown` (0..1) fades them in. Their lights, for the light. */
  readonly update: (t: number, shown: number) => PointLight[];
}

export function blinkers(layer: Container, o: BlinkerOptions): Blinkers {
  const all = o.homes.map((home) => {
    const halo = new Sprite(o.halo);
    halo.anchor.set(0.5);
    halo.blendMode = "add";
    const speck = glyph(["#"], o.color);
    speck.blendMode = "add";
    layer.addChild(halo, speck);
    return { halo, speck, home, phase: Math.random() * 10, speed: 0.25 + Math.random() * 0.35, blink: 1.8 + Math.random() * 1.6 };
  });
  return {
    update: (t, shown) => {
      const lights: PointLight[] = [];
      for (const f of all) {
        const x = f.home.x + Math.sin(t * f.speed + f.phase) * 14 + Math.sin(t * f.speed * 2.3 + f.phase * 1.7) * 5;
        const y = f.home.y + Math.cos(t * f.speed * 0.8 + f.phase) * 8;
        // Lit for most of a blink, then dark, in whole steps: half on the way in and out.
        const into = ((t + f.phase) % f.blink) / f.blink;
        const lit = into < 0.08 || (into > 0.62 && into < 0.7) ? 0.5 : into < 0.62 ? 1 : 0;
        f.speck.position.set(Math.round(x), Math.round(y));
        f.halo.position.set(Math.round(x), Math.round(y));
        f.speck.alpha = f.halo.alpha = lit * shown;
        if (lit * shown > 0) lights.push({ x, y, ...o.light, intensity: o.light.intensity * lit * shown });
      }
      return lights;
    },
  };
}
