// The atlas's pictures as Pixi textures, sized in art pixels: loaded at the atlas's density, so a texture's width is
// its art width and the scene drawn at that density keeps every picture pixel.

import { Assets, Texture, TextureStyle } from "pixi.js";

import type { SpriteAtlas } from "@/ui/pixel/atlas";

const loaded = new Map<string, Promise<Texture>>();
const ready = new Map<string, Texture>();

TextureStyle.defaultOptions.scaleMode = "nearest";

// How many pictures were asked for and how many have come (or failed): the farm's loading bar.
let progress = { done: 0, total: 0 };
const progressListeners = new Set<() => void>();
const moved = (change: Partial<typeof progress>) => {
  progress = { ...progress, ...change };
  progressListeners.forEach((l) => l());
};

/** The pictures' loading so far: a new object on each change. */
export const textureProgress = {
  get: () => progress,
  subscribe: (l: () => void) => {
    progressListeners.add(l);
    return () => void progressListeners.delete(l);
  },
};

/** Loads each once; a missing picture is Texture.EMPTY. */
export function loadTextures(atlas: SpriteAtlas, names: Iterable<string>): Promise<Texture[]> {
  return Promise.all(
    [...names].map((name) => {
      let p = loaded.get(name);
      if (!p) {
        moved({ total: progress.total + 1 });
        p = atlas.has(name)
          ? Assets.load<Texture>({ src: atlas.get(name).url, data: { resolution: atlas.density } })
              .then((t) => {
                t.source.scaleMode = "nearest";
                ready.set(name, t);
                return t;
              })
              .catch(() => Texture.EMPTY)
          : Promise.resolve(Texture.EMPTY);
        p = p.finally(() => moved({ done: progress.done + 1 }));
        loaded.set(name, p);
      }
      return p;
    }),
  );
}

/** A loaded texture, or Texture.EMPTY until loadTextures has it. */
export const texture = (name: string): Texture => ready.get(name) ?? Texture.EMPTY;
