// What happens over a plot when a tool is used on it, in pixels: drops from the watering can, a puff of spray, dust
// from the shovel, the crop popping up at harvest, coins jumping out when the work is taken in. The core says what
// happened (bedFx, gameFx); this draws it with the engine's particles (whole pixels, fading in steps), and a
// harvest flashes a warm light over its plot for a moment. The words that go with them (the note, "+12") are the
// page's labels.

import { dot, particles, type PointLight } from "@vibevalley/engine/pixi";
import type { GameEffectReward, SessionId } from "@vibevalley/protocol";
import { Container, type Graphics, Sprite, type Texture } from "pixi.js";
import type { BedFx } from "../store";
import type { BedFxKind } from "../tools";
import type { Point } from "../world/level";
import { plotH } from "../world/world";

const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);

export interface PlotFx {
  /**
   * Starts what is new in the store's lists (each is started once: the store keeps them a few seconds) and moves
   * everything on by `dt` seconds. `bedOf` is the bed a session's plot is in.
   */
  readonly update: (dt: number, fx: readonly BedFx[], rewards: readonly GameEffectReward[], bedOf: (sessionId: SessionId) => number | undefined) => void;
  /** A plot that was clicked dips a pixel for a moment: when it was, by plot index, on `clock`. */
  readonly pressedAt: Map<number, number>;
  readonly clock: () => number;
  /** The flashes still fading, as lights. */
  readonly lights: () => PointLight[];
}

interface Flash {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly color: number;
  readonly strength: number;
  age: number;
  readonly life: number;
}

export function plotFx(world: Container, texture: (name: string) => Texture, plotAt: (bed: number) => Point): PlotFx {
  const layer = new Container();
  layer.zIndex = 9_000;
  world.addChild(layer);
  const seen = new Set<number>();
  const paid = new WeakSet<GameEffectReward>();
  const bits = particles();
  const flashes: Flash[] = [];
  const pressedAt = new Map<number, number>();
  let clock = 0;

  const add = (node: Graphics | Sprite, p: { x: number; y: number; vx: number; vy: number; fall: number; life: number }) => bits.add(layer, node, p);

  /** The middle of a plot's soil. */
  const centre = (bed: number) => {
    const at = plotAt(bed);
    return { x: at.x, y: at.y - plotH / 2 };
  };

  function burst(kind: BedFxKind, bed: number) {
    const c = centre(bed);
    pressedAt.set(bed, clock);
    switch (kind) {
      case "water":
        // Drops fall from above the plot onto it.
        for (let i = 0; i < 14; i++)
          add(dot(i % 3 ? 0x6fb3e0 : 0xc8e6f7), { x: c.x + rand(-12, 12), y: c.y - rand(14, 26), vx: 0, vy: rand(10, 30), fall: 160, life: rand(0.35, 0.6) });
        return;
      case "spray":
        for (let i = 0; i < 12; i++)
          add(dot(0xf4f1e6, 2), { x: c.x + rand(-4, 4), y: c.y - 4, vx: rand(-24, 24), vy: rand(-26, -6), fall: 0, life: rand(0.5, 0.9) });
        return;
      case "shovel":
        for (let i = 0; i < 12; i++)
          add(dot(i % 2 ? 0x8a6a45 : 0x5d4429, 2), { x: c.x + rand(-8, 8), y: c.y, vx: rand(-30, 30), vy: rand(-50, -20), fall: 140, life: rand(0.4, 0.7) });
        return;
      case "harvest": {
        // The crop jumps out of the plot, with a few golden flecks.
        const icon = new Sprite(texture("icon-harvest"));
        icon.anchor.set(0.5, 1);
        add(icon, { x: c.x, y: c.y, vx: 0, vy: -38, fall: 30, life: 1.1 });
        flashes.push({ x: c.x, y: c.y - 6, radius: 46, color: 0xffd36a, strength: 1.3, age: 0, life: 0.8 });
        for (let i = 0; i < 10; i++)
          add(dot(0xf2c14e), { x: c.x + rand(-6, 6), y: c.y - 4, vx: rand(-30, 30), vy: rand(-60, -30), fall: 150, life: rand(0.5, 0.8) });
        return;
      }
      case "note":
        return;
    }
  }

  function coins(bed: number, n: number) {
    const c = centre(bed);
    flashes.push({ x: c.x, y: c.y - 8, radius: 30, color: 0xffe08a, strength: 0.9, age: 0, life: 0.6 });
    for (let i = 0; i < Math.min(6, Math.max(2, Math.round(n / 5))); i++) {
      const coin = new Sprite(texture("icon-coin"));
      coin.anchor.set(0.5);
      coin.scale.set(0.5);
      add(coin, { x: c.x + rand(-6, 6), y: c.y - 6, vx: rand(-18, 18), vy: rand(-70, -50), fall: 140, life: 0.9 });
    }
  }

  function update(dt: number, fx: readonly BedFx[], rewards: readonly GameEffectReward[], bedOf: (sessionId: SessionId) => number | undefined) {
    clock += dt;
    for (const f of fx) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      burst(f.kind, f.bed);
    }
    for (const r of rewards) {
      if (paid.has(r)) continue;
      paid.add(r);
      const bed = r.sessionId === undefined ? undefined : bedOf(r.sessionId);
      if (bed !== undefined) coins(bed, r.coins);
    }
    for (let i = flashes.length - 1; i >= 0; i--) {
      const f = flashes[i]!;
      f.age += dt;
      if (f.age >= f.life) flashes.splice(i, 1);
    }
    bits.step(dt);
  }

  return {
    update,
    pressedAt,
    clock: () => clock,
    // Bright at once, then gone in a few steps.
    lights: () =>
      flashes.map((f) => ({ x: f.x, y: f.y, z: 12, radius: f.radius, color: f.color, intensity: f.strength * (Math.ceil((1 - f.age / f.life) * 3) / 3) })),
  };
}
