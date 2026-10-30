// @vibevalley/engine/pixi: a pixel-art stage on a canvas. The scene is drawn at its true size (one art pixel = one
// texture pixel) into a texture, which the canvas shows scaled up by a whole number, so every pixel stays square and
// on the grid. Over it, in the same canvas, the ui layer works in screen pixels: words stay sharp at any scale, and
// it takes the pointer and the keyboard (ui.ts: boxes, text, hit regions). The scene only draws; what can be
// clicked is a hit region in the ui layer over it.
//
// A camera can move over the scene a few pixels at a time (swayCamera): the stage keeps a margin of the world out of
// view at every edge, and layers at other depths move more (nearer) or less (farther) than the world, for parallax.
// A game that keeps its world still can move only what is nearer, by where the pointer leans (leanToPointer).
// Per-frame state (where a walker is, which frame it shows) lives in plain objects here, not in React state: the game's
// state says where things should be, this layer moves them there. No React. Light, from normal maps the
// pictures make themselves, is light.ts.

import { Application, Container, RenderTexture, Sprite, TextureStyle, UPDATE_PRIORITY } from "pixi.js";

import type { Point } from "../nav";

export type { Point } from "../nav";
export * from "./critters";
export * from "./light";
export * from "./material";
export * from "./normals";
export * from "./particles";
export * from "./rhythm";
export * from "./sky";

export interface PixelStage {
  readonly app: Application;
  /** The art-pixel scene the camera looks at: the world and the layers at other depths. It only draws. */
  readonly scene: Container;
  /** Everything in the world; children sort by zIndex (set it to the y they stand on). */
  readonly world: Container;
  /** Over the picture, in screen pixels (the canvas's CSS pixels): words, boxes, hit regions. */
  readonly ui: Container;
  /** How far the camera has moved from the middle, art pixels; it moves at most `margin` either way. */
  readonly camera: { x: number; y: number };
  /** The art pixels of the world kept out of view at every edge. */
  readonly margin: number;
  /** The whole world's size, and the part of it in view (the world less its margins), art pixels. */
  readonly size: { readonly w: number; readonly h: number };
  readonly view: { readonly w: number; readonly h: number };
  /**
   * A layer of the scene that moves with the camera by `depth`: the world's is 1, nearer things more, farther less.
   * It goes over everything added to the scene before it.
   */
  readonly layer: (depth: number) => Container;
  /** A world point, as it is on the screen now: where the ui layer puts what goes with it. */
  readonly toScreen: (p: Point) => Point;
  /** A point on the screen (a pointer's), in the world. */
  readonly fromScreen: (p: Point) => Point;
  /** Screen pixels per art pixel, a whole number. */
  readonly scale: () => number;
  /** Where the canvas's top left is in the host, CSS pixels: 0, 0 unless placed by `frame`. */
  readonly offset: () => { readonly x: number; readonly y: number };
  /** Calls `fn` now and whenever the scale (or, with `frame`, the canvas's place) changes. */
  readonly onFit: (fn: (scale: number) => void) => () => void;
  readonly destroy: () => void;
}

export interface PixelStageOptions {
  /** The element the canvas fills (centred, scaled by whole numbers to fit). */
  host: HTMLElement;
  w: number;
  h: number;
  background?: string;
  /** The biggest whole-number scale that fits, but never below this. */
  minScale?: number;
  /** Art pixels of the world kept out of view at every edge, for the camera to move into. */
  margin?: number;
  /**
   * How many of the pictures' pixels make one art pixel (their textures are loaded at this resolution): the scene
   * is drawn at it, so the finer pictures keep their detail while everything is placed in art pixels as before.
   */
  density?: number;
  /**
   * Where the canvas goes in the host instead of the biggest whole scale that fits: its whole-number scale and its top
   * left in the host's CSS pixels (it may stick out; the host should be positioned and clip). Asked on every resize.
   */
  frame?: (host: { w: number; h: number }, view: { w: number; h: number }) => { scale: number; x: number; y: number };
}

export async function pixelStage({
  host,
  w: worldW,
  h: worldH,
  background = "#000000",
  minScale = 1,
  margin = 0,
  density = 1,
  frame,
}: PixelStageOptions): Promise<PixelStage> {
  TextureStyle.defaultOptions.scaleMode = "nearest";
  const app = new Application();
  // The view: the world less its margins.
  const w = worldW - margin * 2;
  const h = worldH - margin * 2;
  // WebGL: the light (light.ts) is a GLSL filter. The device's pixel ratio keeps the ui layer's words sharp.
  await app.init({
    width: w,
    height: h,
    background,
    antialias: false,
    resolution: window.devicePixelRatio > 0 ? window.devicePixelRatio : 1,
    autoDensity: true,
    roundPixels: true,
    preference: "webgl",
  });
  const canvas = app.canvas;
  canvas.style.display = "block";
  host.appendChild(canvas);

  // The scene draws into a texture of the view's size; the canvas shows it scaled up.
  const scene = new Container();
  const world = new Container({ sortableChildren: true });
  scene.addChild(world);
  const art = RenderTexture.create({ width: w, height: h, resolution: density });
  const picture = new Sprite(art);
  const ui = new Container();
  app.stage.addChild(picture, ui);
  const drawScene = () => app.renderer.render({ container: scene, target: art, clear: true, clearColor: background });
  // After the game's updates (NORMAL) and the light's normal pass (-10), before the canvas is drawn (LOW).
  app.ticker.add(drawScene, undefined, -20);

  // Every layer follows the camera by its depth, in whole pixels, before anything else moves in a frame.
  const camera = { x: 0, y: 0 };
  const layers = new Map<Container, number>([[world, 1]]);
  const place = () => {
    const cx = Math.max(-margin, Math.min(margin, camera.x));
    const cy = Math.max(-margin, Math.min(margin, camera.y));
    for (const [layer, depth] of layers) layer.position.set(Math.round(-margin - cx * depth), Math.round(-margin - cy * depth));
  };
  place();
  app.ticker.add(place, undefined, UPDATE_PRIORITY.HIGH);

  let scale = 0;
  const offset = { x: 0, y: 0 };
  if (frame) canvas.style.position = "absolute";
  const listeners = new Set<(s: number) => void>();
  const fit = () => {
    const at = frame?.({ w: host.clientWidth, h: host.clientHeight }, { w, h });
    const next = at ? at.scale : Math.max(minScale, Math.floor(Math.min(host.clientWidth / w, host.clientHeight / h)));
    const moved = at !== undefined && (at.x !== offset.x || at.y !== offset.y);
    if (at) {
      offset.x = at.x;
      offset.y = at.y;
      canvas.style.left = `${at.x}px`;
      canvas.style.top = `${at.y}px`;
    }
    if (next === scale && !moved) return;
    if (next !== scale) {
      scale = next;
      app.renderer.resize(w * scale, h * scale);
      picture.scale.set(scale);
    }
    for (const fn of listeners) fn(scale);
  };
  const ro = new ResizeObserver(fit);
  ro.observe(host);
  fit();

  return {
    app,
    scene,
    world,
    ui,
    camera,
    margin,
    size: { w: worldW, h: worldH },
    view: { w, h },
    layer: (depth) => {
      const layer = new Container();
      scene.addChild(layer);
      layers.set(layer, depth);
      place();
      return layer;
    },
    toScreen: (p) => ({ x: (p.x + world.x) * scale, y: (p.y + world.y) * scale }),
    fromScreen: (p) => ({ x: p.x / scale - world.x, y: p.y / scale - world.y }),
    scale: () => scale,
    offset: () => ({ ...offset }),
    onFit: (fn) => {
      listeners.add(fn);
      if (scale !== 0) fn(scale);
      return () => listeners.delete(fn);
    },
    destroy: () => {
      app.ticker.remove(place);
      app.ticker.remove(drawScene);
      ro.disconnect();
      listeners.clear();
      scene.destroy({ children: true });
      art.destroy(true);
      app.destroy({ removeView: true }, { children: true });
    },
  };
}

export interface LeanOptions {
  /** How much of the lean the pointer drives; the rest is a slow drift of its own. */
  readonly pointer?: number;
  /** How quickly it catches up, per second. */
  readonly ease?: number;
}

export interface PointerLean {
  /** Where it leans now, -1..1 each way: towards where the pointer is over the canvas. */
  readonly at: Point;
  readonly stop: () => void;
}

/**
 * Leans towards where the pointer is over the canvas, easing, and drifts a little on its own. Read `at` in a frame:
 * it is up to date before the stage places its layers (HIGH).
 */
export function leanToPointer(stage: PixelStage, { pointer = 0.7, ease = 2.5 }: LeanOptions = {}): PointerLean {
  const canvas = stage.app.canvas;
  let aim = { x: 0, y: 0 };
  const at = { x: 0, y: 0 };
  const onMove = (e: PointerEvent) => {
    const r = canvas.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const clamp = (v: number) => Math.max(-1, Math.min(1, v));
    aim = { x: clamp(((e.clientX - r.left) / r.width) * 2 - 1), y: clamp(((e.clientY - r.top) / r.height) * 2 - 1) };
  };
  window.addEventListener("pointermove", onMove);
  let t = 0;
  const step = () => {
    const dt = Math.min(0.1, stage.app.ticker.deltaMS / 1000);
    t += dt;
    const drift = 1 - pointer;
    const k = Math.min(1, dt * ease);
    at.x += (aim.x * pointer + Math.sin(t * 0.13) * drift - at.x) * k;
    at.y += (aim.y * pointer + Math.sin(t * 0.09 + 1.3) * drift - at.y) * k;
  };
  stage.app.ticker.add(step, undefined, UPDATE_PRIORITY.HIGH + 1);
  return {
    at,
    stop: () => {
      window.removeEventListener("pointermove", onMove);
      stage.app.ticker.remove(step);
    },
  };
}

export type Facing = "down" | "up" | "left" | "right";

/**
 * Something that walks: it follows a route to its target at a steady speed and knows which way it faces.
 * Call `go` whenever the target may have changed (it only re-routes when it did), `step` once a frame.
 */
export class Walker {
  x: number;
  y: number;
  facing: Facing = "down";
  private path: Point[] = [];
  private target: Point;

  private readonly speed: number;
  private readonly route: (from: Point, to: Point) => Point[];
  constructor(from: Point, speed: number, route: (from: Point, to: Point) => Point[]) {
    this.speed = speed;
    this.route = route;
    this.x = from.x;
    this.y = from.y;
    this.target = from;
  }

  get walking() {
    return this.path.length > 0;
  }

  go(to: Point) {
    if (Math.abs(to.x - this.target.x) < 0.5 && Math.abs(to.y - this.target.y) < 0.5) return;
    this.target = to;
    this.path = this.route({ x: this.x, y: this.y }, to).slice(1);
  }

  /** Moves on by `dt` seconds. */
  step(dt: number) {
    let left = this.speed * dt;
    while (left > 0 && this.path.length > 0) {
      const next = this.path[0]!;
      const dx = next.x - this.x;
      const dy = next.y - this.y;
      const d = Math.hypot(dx, dy);
      if (d > 0.01) this.facing = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? "right" : "left") : dy > 0 ? "down" : "up";
      if (d <= left) {
        this.x = next.x;
        this.y = next.y;
        this.path.shift();
        left -= d;
      } else {
        this.x += (dx / d) * left;
        this.y += (dy / d) * left;
        left = 0;
      }
    }
  }
}

/** Which frame of a looping animation shows at `t` seconds. */
export const frameAt = (t: number, frames: number, fps: number) => Math.floor(t * fps) % frames;
