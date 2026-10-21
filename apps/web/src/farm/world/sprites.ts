// The village's pictures: /pixel/sprites.json (design/pixel/process.py writes it) and a PNG per name beside it. The
// pictures are drawn `density` times denser than the village's art pixels, so a sprite's size in art pixels is its
// manifest size over the density, which is the map's width over the level's (384).

export interface Size {
  readonly w: number;
  readonly h: number;
}

export interface SpriteInfo {
  readonly name: string;
  /** Art pixels. */
  readonly w: number;
  readonly h: number;
  /** The pixel that stands on the ground, art pixels from the top left. */
  readonly ax: number;
  readonly ay: number;
  /** The box of the yard a building's picture covers, art pixels; only some have it. */
  readonly yard?: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
  readonly url: string;
}

export const levelWidth = 384;

export const spriteUrl = (name: string) => `/pixel/${name}.png`;

interface Raw {
  readonly w: number;
  readonly h: number;
  readonly ax: number;
  readonly ay: number;
  readonly yard?: readonly number[];
}

export class SpriteAtlas {
  private constructor(
    private readonly sprites: ReadonlyMap<string, SpriteInfo>,
    readonly density: number,
  ) {}

  static parse(text: string): SpriteAtlas {
    const raw = JSON.parse(text) as Record<string, Raw>;
    const map = raw.map;
    if (!map) throw new Error("sprites.json: no map");
    const d = map.w / levelWidth;
    const sprites = new Map<string, SpriteInfo>();
    for (const [name, v] of Object.entries(raw)) {
      const [x0, y0, x1, y1] = v.yard ?? [];
      const yard =
        x0 !== undefined && y0 !== undefined && x1 !== undefined && y1 !== undefined ? { x0: x0 / d, y0: y0 / d, x1: x1 / d, y1: y1 / d } : undefined;
      sprites.set(name, { name, w: v.w / d, h: v.h / d, ax: v.ax / d, ay: v.ay / d, yard, url: spriteUrl(name) });
    }
    return new SpriteAtlas(sprites, d);
  }

  has(name: string): boolean {
    return this.sprites.has(name);
  }

  get(name: string): SpriteInfo {
    const s = this.sprites.get(name);
    if (!s) throw new Error(`no sprite ${name}`);
    return s;
  }

  /** The first of `names` that exists, else the last: for variants that fall back to a plainer sprite. */
  first(names: readonly string[]): SpriteInfo {
    const name = names.find((n) => this.has(n)) ?? names.at(-1);
    if (name === undefined) throw new Error("no sprite names");
    return this.get(name);
  }

  get names(): IterableIterator<string> {
    return this.sprites.keys();
  }

  /** Pixi's anchor, as a share of the size: the standing pixel's bottom edge, so the feet sit on the point. */
  anchorOf(name: string): { x: number; y: number } {
    const s = this.sprites.get(name);
    return s ? { x: s.ax / s.w, y: (s.ay + 1 / this.density) / s.h } : { x: 0.5, y: 1 };
  }
}
