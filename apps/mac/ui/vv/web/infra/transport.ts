// Where the reused VibeValley web code's requests and streams go. In
// VibeValley they are HTTP (`/api/v1/<op>`) and SSE (`/api/v1/state`,
// `/api/v1/live`); in VibeValley they are the bridge to the Rust server
// (docs/vibevalley-port.md, "Bridge"): `call(op, payload)` answering
// VibeValley's envelope, the `state` and `live` frames. Stories and tests
// set a transport of their own (vv/web/infra/fixtures.ts).
import type { LiveEvent, StateFrame } from "@vibevalley/protocol";

/** VibeValley's response envelope, `{ bizCode, message, data?, error? }`. */
export interface Envelope {
  readonly bizCode: number;
  readonly message: string;
  readonly data?: unknown;
  readonly error?: unknown;
}

export interface Transport {
  /** `op` as VibeValley names it: `issue.status.update`. */
  readonly call: (op: string, payload: unknown) => Promise<Envelope>;
  /** Each StateFrame as it comes; returns how to stop. */
  readonly state: (listener: (frame: StateFrame) => void) => () => void;
  readonly live: (listener: (event: LiveEvent) => void) => () => void;
  /** One of rpc.ts's subscriptions (`channel.follow`, ...): each event as it comes, `ended` once when the server ends
   * or refuses it (null: ended, else the refusal's envelope). Returns how to stop it. */
  readonly subscribe?: (name: string, payload: unknown, on: (event: unknown) => void, ended: (why: Envelope | null) => void) => () => void;
}

/** No server: every call fails as an unreachable one would, no frame comes. */
const offline: Transport = {
  call: () => Promise.reject(new TypeError("no server")),
  state: () => () => {},
  live: () => () => {},
  subscribe: (_name, _payload, _on, ended) => {
    queueMicrotask(() => ended({ bizCode: 100009, message: "no server" }));
    return () => {};
  },
};

let current: Transport = offline;
const changed = new Set<() => void>();

export const transport = (): Transport => current;

/** Swaps the transport (at start-up: the bridge, or a story's fixtures). */
export function setTransport(next: Transport): void {
  current = next;
  for (const fn of changed) fn();
}

export function onTransportChange(fn: () => void): () => void {
  changed.add(fn);
  return () => void changed.delete(fn);
}
