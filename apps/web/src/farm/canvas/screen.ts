// Where the village is on the page, the tool's cursor, and the page's switches for the canvas: framework-free.

import { clock, type VillageScreen } from "@/farm/store";
import type { Village } from "@/farm/world/load";
import type { Scene } from "./scene";

export const background = "#2b3320";

export type Hotspots = Record<string, { hx: number; hy: number }>;

/** The tool's picture as a CSS cursor (1x and 2x), the system's nearest when the pictures are missing. */
export function cssCursor(name: string, spots: Hotspots | undefined) {
  const fallback = name.startsWith("hand") ? "pointer" : "crosshair";
  const spot = spots?.[name];
  if (!spot) return fallback;
  return `image-set(url(/cursors/${name}.png) 1x, url(/cursors/${name}@2x.png) 2x) ${spot.hx} ${spot.hy}, ${fallback}`;
}

export function screenOf(scene: Scene, village: Village, host: HTMLElement): VillageScreen {
  const { stage } = scene;
  const scale = stage.scale();
  const o = stage.offset();
  const { world } = village;
  const w = world.width * scale;
  const h = world.height * scale;
  const x0 = Math.max(0, o.x);
  const y0 = Math.max(0, o.y);
  const toScreen = (p: { x: number; y: number }) => ({ x: o.x + p.x * scale, y: o.y + p.y * scale });
  return {
    scale,
    box: { x: o.x, y: o.y, w, h },
    shown: { x: x0, y: y0, w: Math.max(0, Math.min(host.clientWidth, o.x + w) - x0), h: Math.max(0, Math.min(host.clientHeight, o.y + h) - y0) },
    toScreen,
    plotRect: (bed) => {
      const b = world.plotBox(bed);
      const p = toScreen({ x: b.x0, y: b.y0 });
      return { x: p.x, y: p.y, w: (b.x1 - b.x0) * scale, h: (b.y1 - b.y0) * scale };
    },
    helperAt: (id) => {
      const at = scene.helperAt(id);
      return at && toScreen(at);
    },
    onFrame: (fn) => {
      stage.app.ticker.add(fn, undefined, -30);
      return () => void stage.app.ticker.remove(fn);
    },
  };
}

/** `?light=off` draws without the per-pixel light (a slow GPU, a headless browser). */
export const lightOn = () => new URLSearchParams(location.search).get("light") !== "off";

/** `?tod=0.9` holds the day at that time (0..1, 0.5 is noon): for looking at the night, and for screenshots. */
export function holdTimeOfDay() {
  const tod = Number(new URLSearchParams(location.search).get("tod"));
  if (!new URLSearchParams(location.search).has("tod") || !Number.isFinite(tod)) return;
  clock.setTimeOfDay(tod);
  clock.setSpeed(0);
}
