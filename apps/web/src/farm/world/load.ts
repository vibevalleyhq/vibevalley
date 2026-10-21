// The level and the atlas, fetched once per page (public/village.ldtk, public/pixel).

import { useEffect, useState } from "react";
import { Level } from "./level";
import { SpriteAtlas } from "./sprites";
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

/** undefined while loading; `error` when it could not be loaded. */
export function useVillage(): { village?: Village; error?: string } {
  const [got, setGot] = useState<{ village?: Village; error?: string }>({});
  useEffect(() => {
    let live = true;
    loadVillage().then(
      (village) => live && setGot({ village }),
      (e: unknown) => live && setGot({ error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, []);
  return got;
}
