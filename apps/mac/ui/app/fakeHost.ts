// Plays the Rust side of the bridge in tests: the actions ui/bridge.ts
// posts, answered as crates/vibevalley-bridge's hub and FakeServer answer them
// (calls from `responses`, a function there called with the payload, else
// RouteNotFound; `watch state` sends the
// frame; a subscription is accepted and stays open, its events sent with
// `emit` as `sub:<id>` = { event }, `end` ends it with { end: null }).
// Replies queue until `pump` sends them, since a handler cannot send while
// the app is posting.
import type { OpenOptions } from "nsh/test";

type App = {
  host: { send(name: string, data?: unknown): Promise<void> };
  waitUntil?(condition: () => boolean, options?: { timeout?: number }): Promise<void>;
};

export interface FakeHost {
  readonly options: NonNullable<OpenOptions["host"]>;
  readonly calls: { op: string; payload: unknown }[];
  /** The actions for the shell itself (`act`: openFarm, openTree, ...), in order. */
  readonly acts: { type: string; [key: string]: unknown }[];
  /** Override or add a canned/function RPC answer at runtime. */
  respond(op: string, answer: unknown): void;
  clearCalls(): void;
  /** Sends the queued events until none is left. */
  pump(app: App): Promise<void>;
  /** One pump per hop: an event can queue a further RPC, so a single pump is not enough. */
  pumpUntil(app: App, done: () => boolean, timeoutMs?: number): Promise<void>;
  /** A new frame to every watcher (seq one up), as fake.setState. */
  setState(app: App, state: Record<string, unknown>): Promise<void>;
  /** Push a server LiveEvent on `frame:live`. */
  pushLive(app: App, event: unknown): Promise<void>;
  /** The subscriptions asked for and not stopped: name and payload by id. */
  readonly subscriptions: Map<string, { name: string; payload: unknown }>;
  /** An event to every open subscription of `name` (whose payload `matches`, when given). */
  emit(app: App, name: string, event: unknown, matches?: (payload: unknown) => boolean): Promise<void>;
  /** Ends every open subscription of `name`, as the server dropping its stream. */
  end(app: App, name: string): Promise<void>;
}

export function fakeHost(fixture: { state: unknown; responses: Record<string, unknown> }, params: Record<string, unknown> = {}): FakeHost {
  const queue: [string, unknown][] = [];
  const calls: { op: string; payload: unknown }[] = [];
  const acts: { type: string; [key: string]: unknown }[] = [];
  const responses: Record<string, unknown> = { ...fixture.responses };
  let state = fixture.state as Record<string, unknown>;
  let rev = 0;
  let liveRev = 0;
  let watching = false;
  const subscriptions = new Map<string, { name: string; payload: unknown }>();
  const answer = (op: string, payload: unknown): unknown => {
    if (op === "health") return { bizCode: 0, message: "ok", data: null };
    if (!(op in responses)) return { bizCode: 100005, message: `the fake server has no answer for ${op}` };
    const r = responses[op];
    const v = typeof r === "function" ? (r as (p: unknown) => unknown)(payload) : r;
    return v !== null && typeof v === "object" && "bizCode" in v ? v : { bizCode: 0, message: "ok", data: v };
  };
  const action = (data: unknown) => {
    const a = data as { type: string; id?: string; op?: string; payload?: unknown; topic?: string; name?: string };
    if (a.type === "call") {
      calls.push({ op: a.op ?? "", payload: a.payload });
      queue.push([`reply:${a.id}`, answer(a.op ?? "", a.payload)]);
    } else if (a.type === "subscribe" && a.id !== undefined) {
      subscriptions.set(a.id, { name: a.name ?? "", payload: a.payload });
    } else if (a.type === "unsubscribe" && a.id !== undefined) {
      subscriptions.delete(a.id);
    } else if (a.type === "watch" && a.topic === "state") {
      watching = true;
      queue.push(["frame:state", { rev: ++rev, data: state }]);
    } else if (!["watch", "applied", "ready"].includes(a.type)) {
      acts.push(a);
    }
    return null;
  };
  const pump = async (app: App) => {
    for (let round = 0; round < 50 && queue.length > 0; round++) {
      for (const [name, data] of queue.splice(0)) await app.host.send(name, data);
    }
  };
  const pumpUntil = async (app: App, done: () => boolean, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    await pump(app);
    while (!done()) {
      if (queue.length > 0) {
        await pump(app);
        continue;
      }
      const left = deadline - Date.now();
      if (app.waitUntil === undefined || left <= 0) break;
      await app.waitUntil(() => queue.length > 0 || done(), { timeout: left });
    }
    await pump(app);
  };
  return {
    options: { params: { view: "vibevalley", ...params }, handlers: { action, ready: null } },
    calls,
    acts,
    respond: (op, value) => {
      responses[op] = value;
    },
    clearCalls: () => {
      calls.length = 0;
    },
    pump,
    pumpUntil,
    setState: async (app, next) => {
      state = { ...next, seq: Number(state.seq ?? 0) + 1 };
      if (watching) queue.push(["frame:state", { rev: ++rev, data: state }]);
      await pump(app);
    },
    pushLive: async (app, event) => {
      queue.push(["frame:live", { rev: ++liveRev, data: event }]);
      await pump(app);
    },
    subscriptions,
    emit: async (app, name, event, matches) => {
      for (const [id, s] of subscriptions) if (s.name === name && (matches?.(s.payload) ?? true)) queue.push([`sub:${id}`, { event }]);
      await pump(app);
    },
    end: async (app, name) => {
      for (const [id, s] of [...subscriptions]) {
        if (s.name !== name) continue;
        subscriptions.delete(id);
        queue.push([`sub:${id}`, { end: null }]);
      }
      await pump(app);
    },
  };
}
