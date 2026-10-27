// The level and the atlas, fetched once per page (public/village.ldtk, public/pixel).

import { Level } from "./level";
import { SpriteAtlas } from "../../ui/pixel/atlas";
import { VillageWorld } from "./world";

export interface Village {
  readonly world: VillageWorld;
  readonly atlas: SpriteAtlas;
}

let loading: Promise<Village> | undefined;

const text = async (url: string) => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.text();
};

/** A failed load is tried again on the next call. */
export function loadVillage(): Promise<Village> {
  loading ??= Promise.all([text("/village.ldtk"), text("/pixel/sprites.json")]).then(
    ([ldtk, sprites]) => ({ world: new VillageWorld(Level.parse(ldtk)), atlas: SpriteAtlas.parse(sprites) }),
    (e: unknown) => {
      loading = undefined;
      throw e;
    },
  );
  return loading;
}
