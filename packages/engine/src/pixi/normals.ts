// Normal maps for pixel art, made from the pictures themselves: no one paints them. A sprite is shaped like a pillow
// (it rises with the distance from its outline), with a little relief from how light each painted pixel is; the
// slope of that height is the normal. Pure: pixels in, pixels out (light.ts turns them into textures).
//
// Normals are in screen terms: x to the right, y down the screen, z out of it towards the viewer. Stored as RGBA,
// each axis from -1..1 to 0..255 (128 is 0), the picture's own alpha kept.

export interface NormalOptions {
  /** How far in from the outline, in pixels, a sprite keeps rising: how round it looks. 0: no rounding. */
  readonly bevel: number;
  /** How much a pixel's lightness lifts it: the relief of the painted detail. */
  readonly relief: number;
  /** How steep the slopes come out: the higher, the stronger the shading. */
  readonly strength: number;
}

/** Things attention up: helpers, props, buildings drawn as sprites. */
export const SPRITE_NORMALS: NormalOptions = { bevel: 3, relief: 0.35, strength: 1 };
/** Low things on the ground (plots): barely rounded. */
export const LOW_NORMALS: NormalOptions = { bevel: 1.5, relief: 0.3, strength: 0.8 };
/** The ground itself, a whole map: no outline to round, only the painted relief. */
export const GROUND_NORMALS: NormalOptions = { bevel: 0, relief: 0.6, strength: 0.6 };

/** A pixel this transparent or more is outside the picture. */
const SOLID = 128;

/** The normal map of an RGBA picture `w` by `h`. */
export function normalsOf(rgba: Uint8ClampedArray, w: number, h: number, o: NormalOptions): Uint8ClampedArray {
  const n = w * h;
  const solid = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && (rgba[(y * w + x) * 4 + 3] ?? 0) >= SOLID;

  // How far each solid pixel is from the outside (the picture's edge counts as outside): two chamfer passes.
  const far = new Float32Array(n);
  const cap = Math.max(o.bevel, 0);
  if (cap > 0) {
    for (let i = 0; i < n; i++) far[i] = solid(i % w, Math.floor(i / w)) ? Infinity : 0;
    const at = (x: number, y: number) => (x >= 0 && y >= 0 && x < w && y < h ? (far[y * w + x] ?? 0) : 0);
    const relax = (x: number, y: number, dx: number) => {
      const i = y * w + x;
      const here = far[i] ?? 0;
      if (here === 0) return;
      const best = Math.min(
        here,
        at(x - dx, y) + 1,
        at(x, y - Math.sign(dx)) + 1,
        at(x - dx, y - Math.sign(dx)) + Math.SQRT2,
        at(x + dx, y - Math.sign(dx)) + Math.SQRT2,
      );
      far[i] = best;
    };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) relax(x, y, 1);
    for (let y = h - 1; y >= 0; y--) for (let x = w - 1; x >= 0; x--) relax(x, y, -1);
  }

  // Height: the pillow, and the relief of the painting on it.
  const height = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!solid(i % w, Math.floor(i / w))) continue;
    const pillow = cap > 0 ? Math.sqrt(Math.min(far[i] ?? 0, cap) / cap) : 0;
    const r = rgba[i * 4] ?? 0;
    const g = rgba[i * 4 + 1] ?? 0;
    const b = rgba[i * 4 + 2] ?? 0;
    height[i] = pillow + (o.relief * (0.299 * r + 0.587 * g + 0.114 * b)) / 255;
  }
  // Past the picture's edge the height goes on as at the edge: a map has no rim. (A sprite still rounds at its edge:
  // the pillow is lowest there.)
  const hAt = (x: number, y: number) => height[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))] ?? 0;

  // The slope (Sobel), as a normal.
  const out = new Uint8ClampedArray(n * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const alpha = rgba[i * 4 + 3] ?? 0;
      let nx = 0;
      let ny = 0;
      if (solid(x, y)) {
        const gx = hAt(x + 1, y - 1) + 2 * hAt(x + 1, y) + hAt(x + 1, y + 1) - hAt(x - 1, y - 1) - 2 * hAt(x - 1, y) - hAt(x - 1, y + 1);
        const gy = hAt(x - 1, y + 1) + 2 * hAt(x, y + 1) + hAt(x + 1, y + 1) - hAt(x - 1, y - 1) - 2 * hAt(x, y - 1) - hAt(x + 1, y - 1);
        nx = (-gx / 4) * o.strength;
        ny = (-gy / 4) * o.strength;
      }
      const len = Math.hypot(nx, ny, 1);
      out[i * 4] = Math.round(((nx / len) * 0.5 + 0.5) * 255);
      out[i * 4 + 1] = Math.round(((ny / len) * 0.5 + 0.5) * 255);
      out[i * 4 + 2] = Math.round(((1 / len) * 0.5 + 0.5) * 255);
      out[i * 4 + 3] = alpha;
    }
  }
  return out;
}

/**
 * The normal map for a sprite drawn mirrored (a negative x scale). The sprite's flip mirrors the pixels already; what
 * is left is that each one now faces the other way.
 */
export function mirrorNormals(normals: Uint8ClampedArray): Uint8ClampedArray {
  const out = new Uint8ClampedArray(normals);
  for (let i = 0; i < out.length; i += 4) out[i] = 255 - (normals[i] ?? 128);
  return out;
}
