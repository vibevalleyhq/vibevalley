// Every picture of the atlas as a texture, with the normal maps the light needs (the map is ground, plots are low, the
// rest stand up), and the map's own pixels, for what is painted where (life.ts). Poses change every frame, so all of
// them are loaded before the village is drawn.

import { GROUND_NORMALS, LOW_NORMALS, normalTexture, pixelsOf, SPRITE_NORMALS, type Normals } from "@vibevalley/engine/pixi";
import type { Texture } from "pixi.js";
import type { SpriteAtlas } from "../world/sprites";
import { loadTextures, texture } from "../world/textures";

export interface Pictures {
  readonly has: (name: string) => boolean;
  readonly texture: (name: string) => Texture;
  readonly normalsOf: (t: Texture) => Normals | undefined;
  readonly mapColor: (x: number, y: number) => readonly [number, number, number] | undefined;
}

const shapeOf = (name: string) => (name === "map" ? GROUND_NORMALS : name.startsWith("plot-") ? LOW_NORMALS : SPRITE_NORMALS);

/** `lit`: make the normal maps (a few hundred milliseconds); without them the light treats everything as ground. */
export async function loadPictures(atlas: SpriteAtlas, lit: boolean): Promise<Pictures> {
  const names = [...atlas.names];
  const loaded = await loadTextures(atlas, names);
  const normals = new WeakMap<Texture, Normals>();
  if (lit)
    names.forEach((name, i) => {
      const t = loaded[i];
      const made = t && t.width > 1 ? normalTexture(t, shapeOf(name)) : undefined;
      if (t && made) normals.set(t, made);
    });
  const map = pixelsOf(texture("map"));
  const d = atlas.density;
  return {
    has: (name) => atlas.has(name),
    texture,
    normalsOf: (t) => normals.get(t),
    mapColor: (x, y) => {
      const px = Math.floor(x * d);
      const py = Math.floor(y * d);
      if (!map || px < 0 || py < 0 || px >= map.w || py >= map.h) return undefined;
      const i = (py * map.w + px) * 4;
      return [map.rgba[i] ?? 0, map.rgba[i + 1] ?? 0, map.rgba[i + 2] ?? 0];
    },
  };
}
