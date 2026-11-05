// The level and the atlas, fetched once per page (public/village.ldtk, public/pixel).

import { type Accessor, createSignal, onSettled } from "solid-js";

import { messageOf } from "#/base/format.ts";
import { loadAtlas, type SpriteAtlas } from "#/ui/pixel/atlas.ts";

import { Level } from "./level";
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
function loadVillage(): Promise<Village> {
  loading ??= Promise.all([text("/village.ldtk"), loadAtlas()]).then(
    ([ldtk, atlas]) => ({ world: new VillageWorld(Level.parse(ldtk)), atlas }),
    (e: unknown) => {
      loading = undefined;
      throw e;
    },
  );
  return loading;
}

/** The level and the atlas: undefined while loading; `error` when they could not be loaded. */
export function useVillage(): Accessor<{ village?: Village; error?: string }> {
  const [got, setGot] = createSignal<{ village?: Village; error?: string }>({});
  onSettled(() => {
    let live = true;
    loadVillage().then(
      (village) => live && setGot({ village }),
      (e: unknown) => live && setGot({ error: messageOf(e) }),
    );
    return () => {
      live = false;
    };
  });
  return got;
}
