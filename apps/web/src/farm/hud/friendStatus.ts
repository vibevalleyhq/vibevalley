import type { FarmView, Session } from "@vibevalley/protocol";
import { isBusy, isRipe, plotOf } from "@/farm/world/plots";

export type FriendStatus = "bug" | "ripe" | "busy" | "rest" | "away";

export function statusOf(mine: readonly Session[], view: FarmView): FriendStatus {
  const crops = mine.map((s) => plotOf(view, s).crop);
  if (crops.includes("withered")) return "bug";
  if (crops.some(isRipe)) return "ripe";
  if (mine.some(isBusy)) return "busy";
  return mine.length > 0 ? "rest" : "away";
}
