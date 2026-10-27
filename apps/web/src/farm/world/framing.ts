// Where the village goes in a window: a whole number of screen pixels for each art pixel,
// as large as it can be while its edges cut off at most 5% of its width on each side and 8% of its height above and
// below. A window it cannot fill that way keeps bars.

import type { Size } from "../../ui/pixel/atlas";

export const villageCutAcross = 0.05;
export const villageCutDown = 0.08;

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface VillageFraming {
  /** Screen pixels per art pixel, whole. */
  readonly scale: number;
  /** The whole village, in the window's pixels; it may stick out past the window's edges. */
  readonly box: Rect;
  /** The part of `box` inside the window. */
  readonly shown: Rect;
}

export function frameVillage(window: Size, village: Size): VillageFraming {
  let scale = 1;
  const cover = Math.ceil(Math.max(window.w / village.w, window.h / village.h));
  for (let s = cover; s >= 1; s--) {
    const w = village.w * s;
    const h = village.h * s;
    if ((w - window.w) / 2 <= w * villageCutAcross && (h - window.h) / 2 <= h * villageCutDown) {
      scale = s;
      break;
    }
  }
  const w = village.w * scale;
  const h = village.h * scale;
  // Rounded half away from zero, as Dart's roundToDouble.
  const round = (v: number) => Math.sign(v) * Math.round(Math.abs(v));
  const box = { x: round((window.w - w) / 2), y: round((window.h - h) / 2), w, h };
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(window.w, box.x + w);
  const y1 = Math.min(window.h, box.y + h);
  return { scale, box, shown: { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) } };
}
