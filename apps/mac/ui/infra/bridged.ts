// The transport inside the app: the bridge to the Rust server (ui/bridge.ts,
// docs/vibevalley-port.md "Bridge"). Entries that run in the app call
// `useBridge()` once before mounting; stories and tests keep a transport of
// their own.
import type { SliceKind } from "@vibevalley/protocol";
import { BoardSlice, CollabSlice, FarmFrame, InboxSlice, LiveEvent as LiveEventSchema, OpsSlice, SessionsSlice } from "@vibevalley/protocol/schema";

import { call, onLive, subscribe, watchSlice } from "./bridge";
import { setTransport, type SliceMap, type Transport } from "./transport";

type Decoder<T> = {
  readonly safeParse: (input: unknown) => { readonly success: true; readonly data: T } | { readonly success: false };
};

const sliceDecoders: { readonly [K in SliceKind]: Decoder<SliceMap[K]> } = {
  board: BoardSlice,
  sessions: SessionsSlice,
  collab: CollabSlice,
  inbox: InboxSlice,
  ops: OpsSlice,
  farm: FarmFrame,
};

const bridged: Transport = {
  call: (op, payload) => call(op, payload ?? null),
  slice: (kind, listener) =>
    watchSlice(kind, (data) => {
      const parsed = sliceDecoders[kind].safeParse(data);
      if (parsed.success) listener(parsed.data);
    }),
  live: (listener) =>
    onLive((event) => {
      const parsed = LiveEventSchema.safeParse(event);
      if (parsed.success) listener(parsed.data);
    }),
  subscribe: (name, payload, on, ended) => subscribe(name, payload, on, ended),
};

export function useBridge(): void {
  setTransport(bridged);
}
