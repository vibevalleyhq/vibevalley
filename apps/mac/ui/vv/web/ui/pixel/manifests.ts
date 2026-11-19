// Cursor metadata is tiny (~1 KB) and bundled; the 105 KB sprite manifest
// lives on disk (`assets/pixel/sprites.json`) and is fetched lazily from Rust
// via `host.pixelManifest` on demand instead of inlined into `bundle.js`.
import cursors from "../../../../../../../assets/cursors/cursors.json";
import { transport } from "../../infra/transport";

async function fetchSpriteManifest(): Promise<unknown> {
  const envelope = await transport().call("host.pixelManifest", {});
  if (envelope.bizCode !== 0) throw new Error(envelope.message);
  return envelope.data;
}

/**
 * Lazy thenable adopted by `Promise.resolve(spriteManifest)` in `infra/query.ts`,
 * so `sprites.json` is neither bundled nor fetched until a view calls `useSprites()`.
 */
export const spriteManifest: unknown = {
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return fetchSpriteManifest().then(onfulfilled, onrejected);
  },
};

export const cursorManifest: unknown = cursors;
