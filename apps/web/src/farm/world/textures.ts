// The atlas's pictures as Pixi textures, sized in art pixels: loaded at the atlas's density, so a texture's width is
// its art width and the scene drawn at that density keeps every picture pixel.

import { Assets, Texture, TextureStyle } from "pixi.js";
import type { SpriteAtlas } from "./sprites";

const loaded = new Map<string, Promise<Texture>>();
const ready = new Map<string, Texture>();

TextureStyle.defaultOptions.scaleMode = "nearest";

/** Loads each once; a missing picture is Texture.EMPTY. */
export function loadTextures(atlas: SpriteAtlas, names: Iterable<string>): Promise<Texture[]> {
  return Promise.all(
    [...names].map((name) => {
      let p = loaded.get(name);
      if (!p) {
        p = atlas.has(name)
          ? Assets.load<Texture>({ src: atlas.get(name).url, data: { resolution: atlas.density } })
              .then((t) => {
                t.source.scaleMode = "nearest";
                ready.set(name, t);
                return t;
              })
              .catch(() => Texture.EMPTY)
          : Promise.resolve(Texture.EMPTY);
        loaded.set(name, p);
      }
      return p;
    }),
  );
}

/** A loaded texture, or Texture.EMPTY until loadTextures has it. */
export const texture = (name: string): Texture => ready.get(name) ?? Texture.EMPTY;
