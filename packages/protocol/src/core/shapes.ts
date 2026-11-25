import type { FarmFrame } from "../game/shapes.gen";
import type { BoardSlice, CollabSlice, InboxSlice, OpsSlice, SessionsSlice } from "./shapes.gen";

export * from "./shapes.gen";

/** Each slice kind's payload, as pushed by the server. */
export interface SliceMap {
  readonly board: BoardSlice;
  readonly sessions: SessionsSlice;
  readonly collab: CollabSlice;
  readonly inbox: InboxSlice;
  readonly ops: OpsSlice;
  readonly farm: FarmFrame;
}

/** Every endpoint is a POST at its op, named as in api.ts. */
export const pathOf = (op: string) => "/api/v1/" + op.replaceAll(".", "/");
