// The pixel manifests sit beside the PNGs in the repo's assets/; the views carry
// them and the PNGs come from the app (host.pixelDir).
import cursors from "../../../../../../../assets/cursors/cursors.json";
import sprites from "../../../../../../../assets/pixel/sprites.json";

export const spriteManifest: unknown = sprites;
export const cursorManifest: unknown = cursors;
