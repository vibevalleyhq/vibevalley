// What a tap lands on: the order is the rule. Helpers first (the last drawn on top), then
// the dog, the yard's places, the plots (a little taller than their box).

import type { SessionId } from "@vibevalley/protocol";

import { type Box, inBox, type Point } from "./level";

export type VillageHit =
  | { readonly kind: "session"; readonly id: SessionId }
  | { readonly kind: "dog" }
  | { readonly kind: "spot"; readonly spot: string }
  | { readonly kind: "plot"; readonly bed: number };

export interface VillageHitData {
  /** In drawing order. */
  readonly sessions: ReadonlyMap<SessionId, Box>;
  readonly dog?: Box;
  readonly spots: ReadonlyMap<string, Box>;
  readonly plots: ReadonlyMap<number, Box>;
}

export function villageHitAt(data: VillageHitData, p: Point): VillageHit | undefined {
  for (const [id, box] of [...data.sessions].toReversed()) if (inBox(p, box)) return { kind: "session", id };
  if (data.dog && inBox(p, data.dog)) return { kind: "dog" };
  for (const [spot, box] of [...data.spots].toReversed()) if (inBox(p, box)) return { kind: "spot", spot };
  for (const [bed, b] of [...data.plots].toReversed()) if (inBox(p, { ...b, y0: b.y0 - 4, y1: b.y1 + 2 })) return { kind: "plot", bed };
  return undefined;
}
