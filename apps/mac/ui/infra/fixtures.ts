// A transport answered inside the page from a fixture (`state`, and
// `responses` as vibevalley_bridge::fake reads them): for stories and for
// pictures on a real host, where no Rust side answers the bridge.
import type { LiveEvent, StateFrame } from "@vibevalley/protocol";

import type { Envelope, Transport } from "./transport";

function isEnvelope(value: unknown): value is Envelope {
  return typeof value === "object" && value !== null && "bizCode" in value && typeof value.bizCode === "number";
}

/** `subscriptions`: the events each subscription (by name) sends at once; it then stays open, as a quiet stream would. */
export function fixtureTransport(fixture: {
  state: StateFrame;
  responses: Record<string, unknown>;
  subscriptions?: Record<string, readonly unknown[]>;
}): Transport & { setState: (s: StateFrame) => void } {
  let state = fixture.state;
  const watchers = new Set<(f: StateFrame) => void>();
  const live = new Set<(e: LiveEvent) => void>();
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
    state: (listener) => {
      watchers.add(listener);
      queueMicrotask(() => watchers.has(listener) && listener(state));
      return () => void watchers.delete(listener);
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
      for (const w of watchers) w(state);
    },
  };
}
