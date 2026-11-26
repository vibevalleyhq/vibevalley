// `responses` are read as crates/server/src/transport/bridge/fake.rs reads them: change them there and here together.
import {
  type BoardSlice,
  type CollabSlice,
  type FarmFrame,
  type InboxSlice,
  type LiveEvent,
  type OpsSlice,
  type SessionsSlice,
  type SliceBundle,
  type SliceKind,
  SliceKindValues,
} from "@vibevalley/protocol";

import type { Envelope, SliceMap, Transport } from "./transport";

const SLICE_KINDS = SliceKindValues;

function isEnvelope(value: unknown): value is Envelope {
  return typeof value === "object" && value !== null && "bizCode" in value && typeof value.bizCode === "number";
}

/** `subscriptions`: the events each subscription (by name) sends at once; it then stays open, as a quiet stream would. */
export function fixtureTransport(fixture: {
  state: SliceBundle;
  responses: Record<string, unknown>;
  subscriptions?: Record<string, readonly unknown[]>;
}): Transport & {
  setState: (s: SliceBundle) => void;
  setSlice: <K extends SliceKind>(kind: K, data: SliceMap[K]) => void;
} {
  let state = fixture.state;
  const watchers: { readonly [K in SliceKind]: Set<(data: SliceMap[K]) => void> } = {
    board: new Set<(data: BoardSlice) => void>(),
    sessions: new Set<(data: SessionsSlice) => void>(),
    collab: new Set<(data: CollabSlice) => void>(),
    inbox: new Set<(data: InboxSlice) => void>(),
    ops: new Set<(data: OpsSlice) => void>(),
    farm: new Set<(data: FarmFrame) => void>(),
  };
  const live = new Set<(e: LiveEvent) => void>();

  function notify(kind: SliceKind): void {
    switch (kind) {
      case "board":
        for (const watcher of [...watchers.board]) watcher(state.board);
        break;
      case "sessions":
        for (const watcher of [...watchers.sessions]) watcher(state.sessions);
        break;
      case "collab":
        for (const watcher of [...watchers.collab]) watcher(state.collab);
        break;
      case "inbox":
        for (const watcher of [...watchers.inbox]) watcher(state.inbox);
        break;
      case "ops":
        for (const watcher of [...watchers.ops]) watcher(state.ops);
        break;
      case "farm":
        for (const watcher of [...watchers.farm]) watcher(state.farm);
        break;
    }
  }

  return {
    call: (op, payload) => {
      const r = fixture.responses[op];
      // A function answers by the payload (a vault served in memory).
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- fixture response functions accept one payload argument
      const v = typeof r === "function" ? (r as (p: unknown) => unknown)(payload) : r;
      const envelope: Envelope =
        op === "health"
          ? { bizCode: 0, message: "ok", data: null }
          : !(op in fixture.responses)
            ? { bizCode: 100005, message: `the fixture has no answer for ${op}` }
            : isEnvelope(v)
              ? v
              : { bizCode: 0, message: "ok", data: v };
      return Promise.resolve(envelope);
    },
    slice: <K extends SliceKind>(kind: K, listener: (data: SliceMap[K]) => void) => {
      const set = watchers[kind];
      set.add(listener);
      queueMicrotask(() => set.has(listener) && listener(state[kind]));
      return () => void set.delete(listener);
    },
    live: (listener) => {
      live.add(listener);
      return () => void live.delete(listener);
    },
    subscribe: (name, _payload, on) => {
      let open = true;
      queueMicrotask(() => {
        for (const e of fixture.subscriptions?.[name] ?? []) if (open) on(e);
      });
      return () => {
        open = false;
      };
    },
    setState: (next) => {
      state = next;
      for (const kind of SLICE_KINDS) notify(kind);
    },
    setSlice: (kind, data) => {
      state = { ...state, [kind]: data };
      notify(kind);
    },
  };
}
