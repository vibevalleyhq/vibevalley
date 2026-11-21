// Cursor metadata is tiny (~1 KB) and bundled; the 105 KB sprite manifest
// lives on disk (`assets/pixel/sprites.json`) and is fetched lazily from Rust
// via `host.pixelManifest` on demand instead of inlined into `bundle.js`.
import cursors from "../../../../../../../assets/cursors/cursors.json";
import { transport } from "../../infra/transport";

/** Lazily fetches `sprites.json` from Rust on first `useSprites()` call instead of inlining 105 KB into `bundle.js`. */
export async function loadSpriteManifest(): Promise<unknown> {
  const envelope = await transport().call("host.pixelManifest", {});
  if (envelope.bizCode !== 0) throw new Error(envelope.message);
  return envelope.data;
}

export const cursorManifest: unknown = cursors;
