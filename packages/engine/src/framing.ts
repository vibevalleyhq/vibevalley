// A picture in a view at a whole number of view pixels for each art pixel, as large as it can be while its edges cut off
// at most `cut.across` of its width on each side and `cut.down` of its height above and below. A view it cannot fill
// that way keeps bars.

export interface Size {
  readonly w: number;
  readonly h: number;
}

/** How much of the picture may be cut off on each side, as a share of its width (across) and height (down). */
export interface Cut {
  readonly across: number;
  readonly down: number;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface Framing {
  /** View pixels per art pixel, whole. */
  readonly scale: number;
  /** The whole picture, in the view's pixels; it may stick out past the view's edges. */
  readonly box: Rect;
  /** The part of `box` inside the view. */
  readonly shown: Rect;
}

export function frameWhole(view: Size, picture: Size, cut: Cut): Framing {
  let scale = 1;
  const cover = Math.ceil(Math.max(view.w / picture.w, view.h / picture.h));
  for (let s = cover; s >= 1; s--) {
    const w = picture.w * s;
    const h = picture.h * s;
    if ((w - view.w) / 2 <= w * cut.across && (h - view.h) / 2 <= h * cut.down) {
      scale = s;
      break;
    }
  }
  const w = picture.w * scale;
  const h = picture.h * scale;
  // Rounded half away from zero, as Dart's roundToDouble.
  const round = (v: number) => Math.sign(v) * Math.round(Math.abs(v));
  const box = { x: round((view.w - w) / 2), y: round((view.h - h) / 2), w, h };
  const x0 = Math.max(0, box.x);
  const y0 = Math.max(0, box.y);
  const x1 = Math.min(view.w, box.x + w);
  const y1 = Math.min(view.h, box.y + h);
  return { scale, box, shown: { x: x0, y: y0, w: Math.max(0, x1 - x0), h: Math.max(0, y1 - y0) } };
}

/** Whether the picture covers the whole view: no bars on any side. */
export function fills(view: Size, picture: Size, cut: Cut): boolean {
  const { box } = frameWhole(view, picture, cut);
  return box.x <= 0 && box.y <= 0 && box.x + box.w >= view.w && box.y + box.h >= view.h;
}

/** The view of `view`'s shape nearest in width to it, between `min` and `max`, that the picture fills; `view` itself
 * when it is filled already or none in between is. */
export function filledNear(view: Size, picture: Size, cut: Cut, min: Size, max: Size): Size {
  const shape = view.h / view.w;
  const fit = (w: number): Size | undefined => {
    const h = Math.round(w * shape);
    return w >= min.w && w <= max.w && h >= min.h && h <= max.h && fills({ w, h }, picture, cut) ? { w, h } : undefined;
  };
  for (let d = 0; d <= Math.max(view.w - min.w, max.w - view.w); d++) {
    const found = fit(view.w - d) ?? fit(view.w + d);
    if (found) return d === 0 ? view : found;
  }
  return view;
}
