// The transport inside the app: the bridge to the Rust server (ui/bridge.ts,
// docs/vibevalley-port.md "Bridge"). Entries that run in the app call
// `useBridge()` once before mounting; stories and tests keep a transport of
// their own.
import { LiveEvent as LiveEventSchema, sliceDecoders } from "@vibevalley/protocol/schema";

import { call, onLive, subscribe, watchSlice } from "./bridge";
import { setTransport, type Transport } from "./transport";

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
