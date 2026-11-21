// The transport inside the app: the bridge to the Rust server (ui/bridge.ts,
// docs/vibevalley-port.md "Bridge"). Entries that run in the app call
// `useBridge()` once before mounting; stories and tests keep a transport of
// their own.
import type { LiveEvent, StateFrame } from "@vibevalley/protocol";

import { call, frame, onFrame, onLive, subscribe } from "./bridge";
import { setTransport, type Transport } from "./transport";

const bridged: Transport = {
  call: (op, payload) => call(op, payload ?? null),
  state: (listener) => {
    // frame() asks the server once and keeps the newest; the current one comes first.
    const latest = frame<StateFrame>("state");
    const now = latest();
    if (now) listener(now);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Rust pushes `state` frames in StateFrame shape
    return onFrame("state", (data) => listener(data as StateFrame));
  },
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Rust pushes `live` frames in LiveEvent shape
  live: (listener) => onLive((event) => listener(event as LiveEvent)),
  subscribe: (name, payload, on, ended) => subscribe(name, payload, on, ended),
};

export function useBridge(): void {
  setTransport(bridged);
}
