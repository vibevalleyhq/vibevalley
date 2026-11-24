import type { BoardSlice, CollabSlice, FarmFrame, InboxSlice, LiveEvent, OpsSlice, SessionsSlice, SliceKind } from "@vibevalley/protocol";

/** Each kind's payload, as the server pushes it. */
export interface SliceMap {
  readonly board: BoardSlice;
  readonly sessions: SessionsSlice;
  readonly collab: CollabSlice;
  readonly inbox: InboxSlice;
  readonly ops: OpsSlice;
  readonly farm: FarmFrame;
}

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
