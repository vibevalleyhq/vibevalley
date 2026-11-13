// Where a sprite's picture is. The app keeps the PNGs (assets/pixel) and says where through the
// host op `host.pixelDir` -> { path }, refused (NotFound) when the art is not
// installed: then every sprite is undefined and the views keep their
// stand-ins. The PNGs are read as file: URLs (nsh.json capabilities.fs.read).
// The manifest comes with the views (manifests.ts). SpriteAtlas (the farm's)
// is not ported: the farm is the app's.
import { host } from "nsh";
import { z } from "zod";

import { defineQuery, ready, useQuery } from "../../infra/query";
import { transport } from "../../infra/transport";

const PixelDir = z.object({ path: z.string() });

export const pixelDirQuery = defineQuery({
  schema: PixelDir,
  key: () => ["pixel-dir"],
  fetch: async (): Promise<unknown> => {
    const envelope = await transport().call("host.pixelDir", {});
    if (envelope.bizCode !== 0) throw new Error(envelope.message);
    return envelope.data;
  },
  staleTime: Infinity,
  // NotFound means the art is not installed: asked once.
  retry: 0,
});

/** The folder that holds the sprites' PNGs, undefined until the host said (and when it has none). */
export function usePixelDir(): () => string | undefined {
  const query = useQuery(pixelDirQuery);
  const paramDir = typeof host.params.pixelDir === "string" ? host.params.pixelDir : undefined;
  return () => ready(query, undefined)?.path ?? paramDir;
}

/** `name`'s PNG in `dir`. */
export const spriteUrl = (dir: string, name: string) => `file://${encodeURI(`${dir}/${name}.png`)}`;

/** A sprite's URL, undefined until the art's folder is known. */
export function useSpriteUrl(): (name: string) => string | undefined {
  const dir = usePixelDir();
  return (name) => {
    const d = dir();
    return d === undefined ? undefined : spriteUrl(d, name);
  };
}

/** The cursors' PNGs sit beside the sprites' folder (assets/cursors). */
export function useCursorUrl(): (name: string) => string | undefined {
  const dir = usePixelDir();
  return (name) => {
    const d = dir();
    return d === undefined ? undefined : `file://${encodeURI(`${d.replace(/\/pixel\/?$/u, "")}/cursors/${name}.png`)}`;
  };
}
