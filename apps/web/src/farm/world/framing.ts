// The village in a window (@vibevalley/engine/framing): a whole number of screen pixels for each art pixel, at most 5% of
// its width cut off on each side and 8% of its height above and below (farmFraming); a window it cannot fill keeps bars.

import { type Framing, frameWhole, type Rect, type Size } from "@vibevalley/engine/framing";
import { farmFraming } from "@vibevalley/protocol/host";

export type { Rect };
export type VillageFraming = Framing;

export const villageCutAcross = farmFraming.cut.across;
export const villageCutDown = farmFraming.cut.down;

export const frameVillage = (window: Size, village: Size): VillageFraming => frameWhole(window, village, farmFraming.cut);
