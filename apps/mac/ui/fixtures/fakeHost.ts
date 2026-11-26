// Replies queue until `pump` sends them: a handler cannot send while the app is posting.
import type { OpenOptions } from "nsh/test";

import { SliceKindValues, type SliceBundle, type SliceKind } from "@vibevalley/protocol";
import type { AppletInstallInput, ArtifactAppletInfo } from "@vibevalley/protocol/host";

import type { SliceMap } from "../infra/transport";

type App = {
  host: { send(name: string, data?: unknown): Promise<void>; posts?(): readonly { name: string; data: unknown }[] };
  waitUntil?(condition: () => boolean, options?: { timeout?: number }): Promise<void>;
};

const SLICE_KIND_SET = new Set<string>(SliceKindValues);

function parseSliceTopic(topic: string | undefined): SliceKind | undefined {
  if (topic === undefined || !topic.startsWith("slice:")) return undefined;
  const kind = topic.slice(6);
  return SLICE_KIND_SET.has(kind) ? (kind as SliceKind) : undefined;
}

export interface FakeHost {
  readonly options: NonNullable<OpenOptions["host"]>;
  readonly calls: { op: string; payload: unknown }[];
  /** The actions for the shell itself (`act`: openFarm, ...), in order. */
  readonly acts: { type: string; [key: string]: unknown }[];
  /** Override or add a canned/function RPC answer at runtime. */
  respond(op: string, answer: unknown): void;
  /** Hold RPC replies for `op` indefinitely (e.g., to test loading skeletons). */
  defer(op: string): void;
  clearCalls(): void;
  /** Sends the queued events until none is left. */
  pump(app: App): Promise<void>;
  /** One pump per hop: an event can queue a further RPC, so a single pump is not enough. */
  pumpUntil(app: App, done: () => boolean, timeoutMs?: number): Promise<void>;
  /** To every watched slice, seq one up. */
  setState(app: App, state: SliceBundle): Promise<void>;
  setSlice<K extends SliceKind>(app: App, kind: K, slice: SliceMap[K]): Promise<void>;
  /** Push a server LiveEvent on `frame:live`. */
  pushLive(app: App, event: unknown): Promise<void>;
  /** The subscriptions asked for and not stopped: name and payload by id. */
  readonly subscriptions: Map<string, { name: string; payload: unknown }>;
  /** An event to every open subscription of `name` (whose payload `matches`, when given). */
  emit(app: App, name: string, event: unknown, matches?: (payload: unknown) => boolean): Promise<void>;
  /** Ends every open subscription of `name`, as the server dropping its stream. */
  end(app: App, name: string): Promise<void>;
}

export function fakeHost(fixture: { state: SliceBundle; responses: Record<string, unknown> }, params: Record<string, unknown> = {}): FakeHost {
  const queue: [string, unknown][] = [];
  const calls: { op: string; payload: unknown }[] = [];
  const acts: { type: string; [key: string]: unknown }[] = [];
  const responses: Record<string, unknown> = { ...fixture.responses };
  let state: SliceBundle = fixture.state;
  const sliceRevs: Record<SliceKind, number> = { board: 0, sessions: 0, collab: 0, inbox: 0, ops: 0, farm: 0 };
  const watchedSlices = new Set<SliceKind>();
  const liveRev = { value: 0 };
  const subscriptions = new Map<string, { name: string; payload: unknown }>();
  const installedApplets = new Map<string, ArtifactAppletInfo>();
  const deferredOps = new Set<string>();
  const bound: { app: App | null; seenPosts: number } = { app: null, seenPosts: 0 };
  const defaultHostAnswers: Record<string, (payload: unknown) => unknown> = {
    "host.appletList": () => [...installedApplets.values()],
    "host.appletInstall": (payload: unknown) => {
      const input = payload as AppletInstallInput;
      const slug = input.artifactId.replace(/[^a-zA-Z0-9._-]+/gu, "-").replace(/^-+|-+$/gu, "") || "artifact";
      const info: ArtifactAppletInfo = {
        artifactId: input.artifactId,
        artifactType: input.artifactType,
        appName: input.appName,
        bundleId: `dev.vibevalley.applet.${slug}`,
        bundlePath: `/Users/demo/Applications/VibeValley Apps/${input.appName}.app`,
        alwaysOnTop: input.alwaysOnTop,
        installed: true,
      };
      installedApplets.set(input.artifactId, info);
      return info;
    },
    "host.appletUninstall": (payload: unknown) => {
      const { artifactId } = payload as { artifactId: string };
      return { removed: installedApplets.delete(artifactId) };
    },
    "host.appletOpen": (payload: unknown) => {
      const { artifactId } = payload as { artifactId: string };
      return { opened: installedApplets.has(artifactId) };
    },
    "host.captureWebView": () => null,
  };
  const answer = (op: string, payload: unknown): unknown => {
    if (op === "health") return { bizCode: 0, message: "ok", data: null };
    const hasOverride = op in responses;
    const r = hasOverride ? responses[op] : defaultHostAnswers[op];
    if (r === undefined) return { bizCode: 100005, message: `the fake server has no answer for ${op}` };
    const v = typeof r === "function" ? (r as (p: unknown) => unknown)(payload) : r;
    return v !== null && typeof v === "object" && "bizCode" in v ? v : { bizCode: 0, message: "ok", data: v };
  };
  const processAction = (data: unknown) => {
    const a = data as { type: string; id?: string; op?: string; payload?: unknown; topic?: string; name?: string };
    if (a.type === "call") {
      const op = a.op ?? "";
      calls.push({ op, payload: a.payload });
      if (!deferredOps.has(op)) {
        queue.push([`reply:${a.id}`, answer(op, a.payload)]);
      }
    } else if (a.type === "subscribe" && a.id !== undefined) {
      subscriptions.set(a.id, { name: a.name ?? "", payload: a.payload });
    } else if (a.type === "unsubscribe" && a.id !== undefined) {
      subscriptions.delete(a.id);
    } else if (a.type === "watch") {
      const kind = parseSliceTopic(a.topic);
      if (kind !== undefined) {
        watchedSlices.add(kind);
        queue.push([`frame:slice:${kind}`, { rev: ++sliceRevs[kind], data: state[kind] }]);
      }
    } else if (a.type === "unwatch") {
      const kind = parseSliceTopic(a.topic);
      if (kind !== undefined) watchedSlices.delete(kind);
    } else if (!["applied", "ready"].includes(a.type)) {
      acts.push(a);
    }
  };
  const sync = (app: App | null = bound.app) => {
    if (!app) return;
    bound.app = app;
    const posts = app.host.posts?.();
    if (!posts) return;
    while (bound.seenPosts < posts.length) {
      const msg = posts[bound.seenPosts++];
      if (msg?.name === "action") processAction(msg.data);
    }
  };
  const pump = async (app: App) => {
    bound.app = app;
    for (let round = 0; round < 50; round++) {
      sync(app);
      if (queue.length === 0) break;
      for (const [name, data] of queue.splice(0)) await app.host.send(name, data);
    }
    sync(app);
  };
  const pumpUntil = async (app: App, done: () => boolean, timeoutMs = 5_000) => {
    const deadline = Date.now() + timeoutMs;
    await pump(app);
    while (!done()) {
      sync(app);
      if (queue.length > 0) {
        await pump(app);
        continue;
      }
      const left = deadline - Date.now();
      if (app.waitUntil === undefined || left <= 0) break;
      await app.waitUntil(
        () => {
          sync(app);
          return queue.length > 0 || done();
        },
        { timeout: left },
      );
    }
    await pump(app);
  };
  return {
    options: { params: { view: "vibevalley", ...params }, handlers: { action: null, ready: null } },
    get calls() {
      sync();
      return calls;
    },
    get acts() {
      sync();
      return acts;
    },
    respond: (op, value) => {
      responses[op] = value;
    },
    defer: (op) => {
      deferredOps.add(op);
    },
    clearCalls: () => {
      sync();
      calls.length = 0;
    },
    pump,
    pumpUntil,
    setState: async (app, next) => {
      sync(app);
      const nextSeq = state.seq + 1;
      state = {
        ...next,
        seq: nextSeq,
        board: { ...next.board, seq: Math.max(next.board.seq, nextSeq) },
        sessions: { ...next.sessions, seq: Math.max(next.sessions.seq, nextSeq) },
        collab: { ...next.collab, seq: Math.max(next.collab.seq, nextSeq) },
        inbox: { ...next.inbox, seq: Math.max(next.inbox.seq, nextSeq) },
        ops: { ...next.ops, seq: Math.max(next.ops.seq, nextSeq) },
        farm: { ...next.farm, seq: Math.max(next.farm.seq, nextSeq) },
      };
      for (const kind of watchedSlices) {
        queue.push([`frame:slice:${kind}`, { rev: ++sliceRevs[kind], data: state[kind] }]);
      }
      await pump(app);
    },
    setSlice: async (app, kind, next) => {
      sync(app);
      const nextSeq = state.seq + 1;
      const updated = { ...next, seq: Math.max(next.seq, nextSeq) };
      state = { ...state, seq: nextSeq, [kind]: updated };
      if (watchedSlices.has(kind)) {
        queue.push([`frame:slice:${kind}`, { rev: ++sliceRevs[kind], data: updated }]);
      }
      await pump(app);
    },
    pushLive: async (app, event) => {
      sync(app);
      queue.push(["frame:live", { rev: ++liveRev.value, data: event }]);
      await pump(app);
    },
    get subscriptions() {
      sync();
      return subscriptions;
    },
    emit: async (app, name, event, matches) => {
      sync(app);
      for (const [id, s] of subscriptions) if (s.name === name && (matches?.(s.payload) ?? true)) queue.push([`sub:${id}`, { event }]);
      await pump(app);
    },
    end: async (app, name) => {
      sync(app);
      for (const [id, s] of [...subscriptions]) {
        if (s.name !== name) continue;
        subscriptions.delete(id);
        queue.push([`sub:${id}`, { end: null }]);
      }
      await pump(app);
    },
  };
}
