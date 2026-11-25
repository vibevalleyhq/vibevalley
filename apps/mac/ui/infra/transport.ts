import type { Envelope, LiveEvent, SliceKind, SliceMap } from "@vibevalley/protocol";

export type { Envelope, SliceMap };

export interface Transport {
  /** `op` as VibeValley names it: `issue.status.update`. */
  readonly call: (op: string, payload: unknown) => Promise<Envelope>;
  /** Each frame of `kind` as it comes; returns how to stop. */
  readonly slice: <K extends SliceKind>(kind: K, listener: (data: SliceMap[K]) => void) => () => void;
  readonly live: (listener: (event: LiveEvent) => void) => () => void;
  /** One of api.ts's subscriptions (`channel.follow`, ...): each event as it comes, `ended` once when the server ends
   * or refuses it (null: ended, else the refusal's envelope). Returns how to stop it. */
  readonly subscribe?: (name: string, payload: unknown, on: (event: unknown) => void, ended: (why: Envelope | null) => void) => () => void;
}

/** No server: every call fails as an unreachable one would, no frame comes. */
const offline: Transport = {
  call: () => Promise.reject(new TypeError("no server")),
  slice: () => () => {},
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
