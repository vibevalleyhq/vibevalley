// The village's own life, as the farm sets it up from the engine's pieces (@vibevalley/engine/pixi: particles, critters,
// rhythm, materialOf): smoke from the chimneys, butterflies by day and birds flying over, fireflies after dark, the
// pond's ripples, glints and fish, leaves on the wind, the dog's Zzz, dust where helpers walk. What helpers are doing
// shows where they do it: the anvil sparks while someone runs commands at the workshop, pages flutter at the book
// house, the mast sends while someone is on the web, Zzz over the bench; ripe plots twinkle. A click where nothing
// else takes it answers by what is painted there: dust from the soil, bits from the grass, a splash from the pond.
// None of it is the farm's state: it is drawn from it, every frame.

import { Container, Sprite, type Texture } from "pixi.js";

import {
  blinkers,
  cadence,
  dot,
  flocks,
  flutterers,
  glowTexture,
  glyph,
  gust,
  materialOf,
  particles,
  shadowTexture,
  type Flap,
  type Material,
  type Point,
  type PointLight,
} from "@vibevalley/engine/pixi";

import { playSound } from "@/ui/pixel/sound";

/** x0, y0, x1, y1. */
export type Box = readonly [number, number, number, number];

/** The places helpers work at, besides their plot. */
export type Place = "bench" | "library" | "workshop" | "mast";

/** What life needs of the village (world/world.ts, the sprites, the map's own pixels). */
export interface LifeWorld {
  readonly width: number;
  readonly dog: Point;
  readonly fx: { readonly chimney: readonly Box[]; readonly anvil: readonly Box[]; readonly mast: readonly Box[]; readonly pond: readonly Box[] };
  /** The workshop's box: its chimney smokes harder while someone works there. */
  readonly workshop: Box;
  readonly places: Readonly<Partial<Record<Place, Point>>>;
  readonly has: (name: string) => boolean;
  readonly texture: (name: string) => Texture;
  /** The map's colour at a point; undefined off the map. */
  readonly mapColor: (x: number, y: number) => readonly [number, number, number] | undefined;
}

const inRect = (p: Point, b: Box) => p.x >= b[0] && p.x < b[2] && p.y >= b[1] && p.y < b[3];

export interface LifeFrame {
  readonly t: number;
  readonly dt: number;
  /** 0 by day, 1 at night. */
  readonly night: number;
  /** Where helpers are walking now, at their feet. */
  readonly walkers: readonly Point[];
  /** How many helpers are at work at each building now. */
  readonly busy: Readonly<Partial<Record<Place, number>>>;
  /** The ripe plots' soil. */
  readonly ripe: readonly Box[];
  readonly dogAsleep: boolean;
}

export interface LifeLayers {
  /** In the lit world, over everything attention: smoke, dust, leaves, ripples, butterflies, birds. */
  readonly world: Container;
  /** Over the lit world, added: what shines (sparks, twinkles, glints, fireflies, the mast's waves and lamp). */
  readonly glows: Container;
  /** Over the lit world, as painted: hearts, Zzz, the ring where a click landed. */
  readonly marks: Container;
}

export interface Life {
  /** Moves everything on; the lights it makes (fireflies, the anvil's flashes, the mast's lamp), for the light. */
  readonly update: (frame: LifeFrame) => PointLight[];
  /** A click on the yard that nothing else took. */
  readonly poke: (x: number, y: number) => void;
  /** A heart over something that was petted. */
  readonly heart: (x: number, y: number) => void;
}

const HEART = [".#.#.", "#####", ".###.", "..#.."];
const ZED = ["####", "..#.", ".#..", "####"];
const SPARKLE = [".#.", "###", ".#."];
const BUTTERFLY: Flap = [
  ["#.#", ".#."],
  [".#.", ".#."],
];
const BIRD: Flap = [
  ["#...#", ".###."],
  [".###.", "#...#"],
];

/** Where butterflies keep to: the lawns and the flower beds. */
const MEADOWS: readonly Box[] = [
  [12, 110, 90, 215],
  [300, 140, 380, 200],
  [90, 92, 300, 110],
];
/** The yard below the houses, where fireflies drift. */
const YARD: Box = [40, 100, 330, 236];

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
const inside = (box: Box): Point => ({ x: rand(box[0], box[2]), y: rand(box[1], box[3]) });

export function villageLife(layers: LifeLayers, v: LifeWorld): Life {
  const { has, texture, mapColor } = v;
  const FX = v.fx;
  const lit = new Container();
  lit.zIndex = 9_100;
  layers.world.addChild(lit);
  const shine = new Container();
  layers.glows.addChild(shine);
  const { marks } = layers;

  const bits = particles();
  const { due } = cadence();
  const puff = glowTexture(4, 0xebe6dc, 0.9);
  const dustPuff = glowTexture(3, 0xf6e7c6, 0.8);
  // The critters' pictures (design/pixel critters), or their glyphs when a picture is missing. Butterflies are drawn
  // white and take their colour; birds keep theirs.
  const flap = (name: string, glyphs: Flap): Flap => (has(`${name}-1`) && has(`${name}-2`) ? [texture(`${name}-1`), texture(`${name}-2`)] : glyphs);
  const birdFrames = flap("critter-bird", BIRD);
  const butterflies = flutterers(lit, {
    homes: Array.from({ length: 5 }, (_, i) => inside(MEADOWS[i % MEADOWS.length] ?? YARD)),
    colors: [0xf6f1e4, 0xf5d76e, 0xf2a6b8],
    frames: flap("critter-butterfly", BUTTERFLY),
  });
  const birds = flocks(lit, {
    frames: birdFrames,
    color: birdFrames === BIRD ? 0x33302c : 0xffffff,
    shadow: shadowTexture(7, 3),
    drop: 70,
    width: v.width,
    heights: [18, 120],
  });
  /** A picture from the critters sheet, centred, facing `dir` (1 right, -1 left); a dot when it is missing. */
  const critter = (name: string, fallback: () => Container, dir = 1): Container => {
    if (!has(name)) return fallback();
    const s = new Sprite(texture(name));
    s.anchor.set(0.5);
    s.scale.x = dir;
    return s;
  };
  const fireflies = blinkers(shine, {
    homes: Array.from({ length: 12 }, () => inside(YARD)),
    color: 0xeaff9e,
    halo: glowTexture(6, 0xc6ff70, 0.5),
    light: { z: 4, radius: 14, color: 0xc6ff70, intensity: 0.85 },
  });
  let flash = 0;

  /** What is painted at a point; the pond's water is 'pond' (a teal roof is not). */
  const groundAt = (x: number, y: number): Material | "pond" | undefined => {
    const c = mapColor(x, y);
    if (!c) return undefined;
    const m = materialOf(c[0], c[1], c[2]);
    return m === "water" && FX.pond.some((b) => inRect({ x, y }, b)) ? "pond" : m;
  };
  /** A random point in `box` painted `want`, or undefined after a few tries. */
  const somewhere = (box: Box, want: Material | "pond"): Point | undefined => {
    for (let i = 0; i < 8; i++) {
      const p = inside(box);
      if (groundAt(p.x, p.y) === want) return p;
    }
    return undefined;
  };
  const workshopChimney = (b: Box) => inRect({ x: (b[0] + b[2]) / 2, y: b[1] }, v.workshop);
  const soft = (texture: Texture) => {
    const s = new Sprite(texture);
    s.anchor.set(0.5);
    return s;
  };
  const zed = (x: number, y: number) => bits.add(marks, glyph(ZED, 0xf4efe0), { x, y, vx: 3, vy: -5, sway: 1.5, alpha: 0.85, life: 2.2 });

  function poke(x: number, y: number) {
    bits.ring(marks, { x, y, from: 1, to: 5, squash: 0.5, color: 0xfff6d8, life: 0.35 });
    switch (groundAt(x, y)) {
      case "pond":
        for (let i = 0; i < 8; i++) bits.add(lit, dot(0xcfeff2), { x, y, vx: rand(-25, 25), vy: rand(-55, -25), fall: 170, life: rand(0.4, 0.6) });
        bits.ring(lit, { x, y, from: 1, to: 7, squash: 0.45, color: 0xbfe3e6, life: 0.9 });
        bits.ring(lit, { x, y, from: 1, to: 4, squash: 0.45, color: 0xbfe3e6, life: 0.6 });
        return playSound("splash");
      case "leaves":
        for (let i = 0; i < 7; i++)
          bits.add(lit, dot(pick([0x9dbb4e, 0x7d9a3a, 0xc8d36a])), {
            x: x + rand(-2, 2),
            y,
            vx: rand(-22, 22),
            vy: rand(-42, -16),
            fall: 110,
            life: rand(0.5, 0.75),
          });
        for (let i = 0; i < 2; i++)
          bits.add(lit, dot(pick([0x8aa43a, 0xc9a23a]), 2), {
            x,
            y: y - 2,
            vx: rand(-6, 6),
            vy: rand(-10, -4),
            fall: 14,
            sway: 5,
            drift: 0.6,
            life: rand(1.2, 1.8),
          });
        return playSound("rustle");
      case "soil":
        for (let i = 0; i < 10; i++)
          bits.add(lit, dot(pick([0xf6e3bd, 0xe9cfa0, 0xfff2d6]), pick([1, 1, 2])), {
            x: x + rand(-2, 2),
            y,
            vx: rand(-28, 28),
            vy: rand(-24, -6),
            fall: 40,
            life: rand(0.35, 0.6),
          });
        for (let i = 0; i < 2; i++) bits.add(lit, soft(dustPuff), { x: x + rand(-3, 3), y: y - 1, vx: rand(-8, 8), vy: -4, grow: 1.2, alpha: 0.8, life: 0.5 });
        return playSound("thud");
      case "stone":
      case "water":
      case "other":
        for (let i = 0; i < 4; i++) bits.add(shine, dot(0xfff6d8), { x, y, vx: rand(-20, 20), vy: rand(-28, -8), fall: 60, life: 0.3 });
        return playSound("tap");
      case undefined:
        return;
    }
  }

  function update(f: LifeFrame): PointLight[] {
    const { t, dt, night } = f;
    const day = Math.max(0, 1 - night * 1.6);
    const wind = gust(t);
    const lights: PointLight[] = [];

    // Chimneys smoke; the workshop's thicker while someone works there.
    FX.chimney.forEach((b, i) => {
      const busy = workshopChimney(b) && (f.busy.workshop ?? 0) > 0;
      if (due(`smoke:${i}`, busy ? 0.22 : 0.45, t))
        bits.add(lit, soft(puff), {
          x: (b[0] + b[2]) / 2 + rand(-1, 1),
          y: b[1],
          vy: rand(-7, -5),
          drift: 6,
          sway: 1,
          grow: 0.7,
          alpha: night > 0.5 ? 0.5 : 0.8,
          life: rand(2.6, 3.4),
        });
    });

    // Leaves come off the trees on the wind.
    if (due("leaf", 2.6 / (0.4 + wind), t)) {
      const from = somewhere([0, 26, v.width, 70], "leaves") ?? somewhere([0, 100, 70, 220], "leaves");
      if (from)
        bits.add(
          lit,
          critter(pick(["critter-leaf-1", "critter-leaf-2"]), () => dot(pick([0x8aa43a, 0x6f8f2f, 0xc9a23a]), pick([1, 2]))),
          { ...from, vy: rand(6, 10), drift: 10, sway: 6, life: rand(3.5, 5.5) },
        );
    }

    // The pond: ripples, sun glints, now and then a fish.
    for (const pond of FX.pond) {
      const ripple = due("ripple", 1.2, t) ? somewhere(pond, "pond") : undefined;
      if (ripple) bits.ring(lit, { ...ripple, from: 1, to: rand(4, 7), squash: 0.45, color: 0xbfe3e6, life: 1.3 });
      const glint = day > 0.3 && due("glint", 0.12, t) ? somewhere(pond, "pond") : undefined;
      if (glint) bits.add(shine, dot(0xfffbe8), { ...glint, alpha: day, life: 0.3 });
      const fish = due("fish", 18, t) ? somewhere(pond, "pond") : undefined;
      if (fish) {
        const dir = Math.random() < 0.5 ? -1 : 1;
        bits.add(
          lit,
          critter("critter-fish-1", () => dot(0xd9874a, 2), dir),
          { ...fish, vx: rand(14, 22) * dir, vy: -30, fall: 100, life: 0.6 },
        );
        bits.ring(lit, { ...fish, from: 1, to: 5, squash: 0.45, color: 0xbfe3e6, life: 0.8 });
      }
    }

    // The dog dozes.
    if (f.dogAsleep && due("zzz", 1.8, t)) zed(v.dog.x + 5, v.dog.y - 13);

    // Dust where helpers walk on the yard; a blade or two on the grass.
    if (due("dust", 0.16, t)) {
      for (const w of f.walkers) {
        const at = groundAt(w.x, w.y);
        if (at === "soil")
          bits.add(lit, dot(pick([0xf6e3bd, 0xe9cfa0]), pick([1, 2])), {
            x: w.x + rand(-3, 3),
            y: w.y - 1,
            vx: rand(-6, 6),
            vy: rand(-6, -2),
            fall: 10,
            alpha: 0.85,
            life: rand(0.35, 0.55),
          });
        else if (at === "leaves" && Math.random() < 0.35) bits.add(lit, dot(0x9dbb4e), { x: w.x + rand(-3, 3), y: w.y - 1, vy: -6, fall: 30, life: 0.35 });
      }
    }

    // The workshop: the anvil sparks while someone works there, and each strike flashes.
    const anvil = FX.anvil[0];
    if (anvil && (f.busy.workshop ?? 0) > 0 && due("anvil", 0.3, t)) {
      const cx = (anvil[0] + anvil[2]) / 2;
      for (let i = 0; i < 4; i++)
        bits.add(shine, dot(pick([0xffd27a, 0xffb347, 0xfff1c2])), {
          x: cx + rand(-2, 2),
          y: anvil[1],
          vx: rand(-32, 32),
          vy: rand(-48, -20),
          fall: 130,
          life: rand(0.3, 0.6),
        });
      flash = 0.16;
    }
    if (anvil && flash > 0) {
      flash -= dt;
      lights.push({ x: (anvil[0] + anvil[2]) / 2, y: anvil[1], z: 8, radius: 28, color: 0xffb347, intensity: 1.1 });
    }

    // The book house: pages flutter up while someone reads there.
    const library = v.places.library;
    if (library && (f.busy.library ?? 0) > 0 && due("pages", 0.45, t)) {
      const at = library;
      bits.add(lit, dot(0xf3efe3, 2), { x: at.x + rand(-8, 8), y: at.y - 18, vy: rand(-8, -4), sway: 4, drift: 0.4, life: 1.6 });
    }

    // The mast: waves go out while someone is on the web; its lamp blinks red at night.
    const mast = FX.mast[0];
    if (mast) {
      const top = { x: (mast[0] + mast[2]) / 2, y: mast[1] };
      if ((f.busy.mast ?? 0) > 0 && due("waves", 0.6, t)) bits.ring(shine, { ...top, from: 2, to: 14, squash: 1, color: 0x8fe3ff, life: 0.9 });
      if (night > 0.3 && t % 1.6 < 0.9) {
        if (due("beacon", 0.05, t)) bits.add(shine, dot(0xff5a4a), { x: top.x, y: top.y - 1, life: 0.06 });
        lights.push({ ...top, z: 6, radius: 14, color: 0xff5a4a, intensity: 0.7 * night });
      }
    }

    // Someone waiting on the bench nods off.
    const bench = v.places.bench;
    if (bench && (f.busy.bench ?? 0) > 0 && due("bench", 1.6, t)) zed(bench.x + 2, bench.y - 26);

    // Ripe plots twinkle.
    f.ripe.forEach((b, i) => {
      if (due(`ripe:${i}`, 0.35, t)) bits.add(shine, glyph(SPARKLE, 0xffe9a0), { x: rand(b[0] + 2, b[2] - 4), y: rand(b[1] - 6, b[1] + 6), vy: -4, life: 0.6 });
    });

    // Butterflies by day, birds now and then, fireflies after dark.
    butterflies.update(t, dt, day);
    if (day > 0.5 && due("birds", 28, t)) birds.launch(0.3 * day);
    birds.update(t, dt);
    lights.push(...fireflies.update(t, night > 0.4 ? (night - 0.4) / 0.6 : 0));

    bits.step(dt, wind);
    return lights;
  }

  return { update, poke, heart: (x, y) => bits.add(marks, glyph(HEART, 0xff7a9a), { x: x - 2, y: y - 4, vy: -12, sway: 2, life: 1.1 }) };
}
