// The Rust <-> TSX bridge (Rust side: crates/vibevalley-bridge, apps/mac/src/hosted).
//
// Server traffic, in VibeValley's shapes:
//   call(op, payload)            -> Promise<Envelope>        (action "call", event "reply:<id>")
//   watchSlice(kind, fn)         -> SliceMap[kind] stream    (actions "watch"/"unwatch", events "frame:slice:<kind>")
//   frame("live") / onLive(fn)   -> LiveEvents               (action "watch", events "frame:live")
//   subscribe(name, payload, on, ended) -> stop              (actions "subscribe"/"unsubscribe", events "sub:<id>")
// Host capabilities (VibeValley's packages/protocol/src/host.ts, plus the terminal):
//   hostApi.notify / tray / locale / reveal / theme / opening / openTerminal / openUrl / openFile / pixelDir / info
//   = call("host.<name>", payload), answered by the shell.
// Shell frames and actions (VibeValley's own panels): frame(<topic>) for topics Rust pushes,
// act({ type, ... }) for intent back.
import { cleanup, host, signal, type Signal } from "nsh";

import type { SliceKind } from "@vibevalley/protocol";
import type { CommandLineState, MotionChoice } from "@vibevalley/protocol/host";

import { readHostViewName } from "./hostParams";

export type Next = { say: string; run?: readonly string[] };
export type ErrorDetail = { next?: readonly Next[]; settings?: string };
/** VibeValley's response envelope. `bizCode` 0 is success. */
export type Envelope<T = unknown> = { bizCode: number; message: string; data?: T; error?: ErrorDetail };

/** Envelope codes the bridge itself produces (VibeValley's BizCode values). */
const BridgeCode = { Ok: 0, ServiceUnavailable: 100009 } as const;

let counter = 0;
const nextId = () => `${Date.now().toString(36)}.${(++counter).toString(36)}`;

function isEnvelope(value: unknown): value is Envelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "bizCode" in value &&
    typeof value.bizCode === "number" &&
    "message" in value &&
    typeof value.message === "string"
  );
}

function isFrameEnvelope(value: unknown): value is FrameEnvelope<unknown> {
  return typeof value === "object" && value !== null && "rev" in value && typeof value.rev === "number" && "data" in value;
}

function isSubMessage(value: unknown): value is { event?: unknown; end?: Envelope | null } {
  return typeof value === "object" && value !== null;
}

/**
 * Registers a `host.on` listener outside any active nsh reactive owner.
 *
 * nsh attaches `host.on` cleanup to the current component or `effect` owner
 * (`undo_with_owner`), which would silently drop RPC replies, frame streams,
 * or live subscriptions whenever that transient owner re-runs or disposes.
 * Deferring to a microtask runs unowned; nsh's HostInbox buffers any event
 * sent before the listener attaches and delivers it once registered.
 */
function listenDetached(event: string, listener: (payload: unknown) => void): () => void {
  let active = true;
  let off: (() => void) | undefined;
  queueMicrotask(() => {
    if (!active) return;
    off = host.on(event, (payload) => {
      if (active) listener(payload);
    });
  });
  return () => {
    if (!active) return;
    active = false;
    off?.();
    off = undefined;
  };
}

/** One endpoint by name. Never rejects: failures are envelopes with a non-zero bizCode. */
export function call<T = unknown>(op: string, payload: unknown = null, options?: { timeoutMs?: number }): Promise<Envelope<T>> {
  return new Promise((resolve) => {
    if (!host.available()) {
      resolve({ bizCode: BridgeCode.ServiceUnavailable, message: "no host to answer this call" });
      return;
    }
    const id = nextId();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = listenDetached(`reply:${id}`, (envelope) => {
      stop();
      if (timer !== undefined) clearTimeout(timer);
      if (isEnvelope(envelope)) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- bridge RPC callers decode `data` per op schema
        resolve(envelope as Envelope<T>);
      } else {
        resolve({ bizCode: BridgeCode.ServiceUnavailable, message: `${op}: invalid bridge envelope` });
      }
    });
    if (options?.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)) {
      timer = setTimeout(() => {
        stop();
        resolve({ bizCode: BridgeCode.ServiceUnavailable, message: `${op}: no answer in ${options.timeoutMs} ms` });
      }, options.timeoutMs);
    }
    host.post("action", { type: "call", id, op, payload });
  });
}

export type FrameEnvelope<T> = { rev: number; data: T };

interface TopicEntry {
  readonly store: Signal<FrameEnvelope<unknown> | null>;
  readonly listeners: Set<(data: unknown) => void>;
  latest: FrameEnvelope<unknown> | null;
  watchers: number;
  detach?: () => void;
}

const SLICE_PREFIX = "slice:";
const isSliceTopic = (name: string): boolean => name.startsWith(SLICE_PREFIX);

const topics = new Map<string, TopicEntry>();
/** Permanent server topics; the view asks for them once, on first use. */
const serverTopics = new Set(["live"]);

function ensureEntry(name: string): TopicEntry {
  let entry = topics.get(name);
  if (entry) return entry;
  entry = {
    store: signal<FrameEnvelope<unknown> | null>(null),
    listeners: new Set(),
    latest: null,
    watchers: 0,
  };
  topics.set(name, entry);
  return entry;
}

function attachTopicListener(name: string, entry: TopicEntry): () => void {
  return listenDetached(`frame:${name}`, (payload) => {
    if (!isFrameEnvelope(payload)) return;
    entry.latest = payload;
    entry.store.set(payload);
    // A slice receipt releases the next snapshot. Other non-live receipts feed the debug dump.
    if (name !== "live") host.post("action", { type: "applied", topic: name, rev: payload.rev });
    for (const listener of [...entry.listeners]) listener(payload.data);
  });
}

function acquireSlice(name: string): { readonly entry: TopicEntry; readonly release: () => void } {
  const entry = ensureEntry(name);
  entry.watchers += 1;
  if (entry.watchers === 1) {
    entry.detach = attachTopicListener(name, entry);
    if (host.available()) host.post("action", { type: "watch", topic: name });
  }
  let released = false;
  return {
    entry,
    release: () => {
      if (released) return;
      released = true;
      entry.watchers -= 1;
      if (entry.watchers > 0) return;
      entry.detach?.();
      entry.detach = undefined;
      entry.latest = null;
      entry.store.set(null);
      if (host.available()) host.post("action", { type: "unwatch", topic: name });
    },
  };
}

function topic(name: string): TopicEntry {
  const existing = topics.get(name);
  if (existing && existing.detach !== undefined) return existing;
  const entry = ensureEntry(name);
  entry.detach = attachTopicListener(name, entry);
  if (serverTopics.has(name) && host.available()) host.post("action", { type: "watch", topic: name });
  return entry;
}

/** Watches a server slice topic (`slice:<kind>`), delivering the newest cached frame if already active and unwatching when the last caller stops. */
export function watchSlice(kind: SliceKind, listener: (data: unknown) => void): () => void {
  const name = `${SLICE_PREFIX}${kind}`;
  const { entry, release } = acquireSlice(name);
  entry.listeners.add(listener);
  if (entry.latest !== null) listener(entry.latest.data);
  let active = true;
  return () => {
    if (!active) return;
    active = false;
    entry.listeners.delete(listener);
    release();
  };
}

/** The latest frame of `name` (reactive), `null` until the first one. Slice topics (`slice:<kind>`) watch on mount and unwatch on cleanup. */
// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- each topic pushes its own contract shape from Rust
export function frame<T = unknown>(name: string): () => T | null {
  if (isSliceTopic(name)) {
    const { entry, release } = acquireSlice(name);
    cleanup(release);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Rust pushes each topic in its own contract shape
    return () => (entry.store()?.data as T | undefined) ?? null;
  }
  const { store } = topic(name);
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Rust pushes each topic in its own contract shape
  return () => (store()?.data as T | undefined) ?? null;
}

/** The frame's revision (reactive): goes up by one per frame this view received. */
export function frameRev(name: string): () => number {
  if (isSliceTopic(name)) {
    const { entry, release } = acquireSlice(name);
    cleanup(release);
    return () => entry.store()?.rev ?? 0;
  }
  const { store } = topic(name);
  return () => store()?.rev ?? 0;
}

/** Subscribes to each incoming frame payload on `name` (validating the FrameEnvelope wrapper). */
function onFrame(name: string, listener: (data: unknown) => void): () => void {
  const { listeners } = topic(name);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Every LiveEvent from now on. Returns how to stop listening. */
export function onLive(listener: (event: unknown) => void): () => void {
  return onFrame("live", listener);
}

/** One of rpc.ts's subscriptions (`channel.follow`, ...). `ended` gets `null` when the server ended it,
 * or the refusal's envelope. Returns how to stop it. */
export function subscribe(name: string, payload: unknown, on: (event: unknown) => void, ended?: (why: Envelope | null) => void): () => void {
  const id = nextId();
  let open = true;
  const off = listenDetached(`sub:${id}`, (message) => {
    if (!open || !isSubMessage(message)) return;
    if ("end" in message) {
      open = false;
      off();
      ended?.(message.end ?? null);
    } else {
      on(message.event);
    }
  });
  host.post("action", { type: "subscribe", id, name, payload });
  return () => {
    if (!open) return;
    open = false;
    off();
    host.post("action", { type: "unsubscribe", id });
  };
}

/** The host's capabilities (packages/protocol's Host, desktop flavour) and the terminal. */
export const hostApi = {
  info: () =>
    call<{
      name: string;
      version: string;
      titleBar: { top: number; left: number } | null;
      terminal: boolean;
      monoFont?: string;
      monoFonts?: string[];
      terminalFontSize?: number;
      uiFontSize?: number;
      motion?: MotionChoice;
      capabilities: string[];
    }>("host.info"),
  updateState: () => call("host.updateState", null, { timeoutMs: 5_000 }),
  updateCheck: () => call<void>("host.updateCheck"),
  updateInstall: () => call<void>("host.updateInstall"),
  font: (font: { monoFont?: string; terminalFontSize?: number; uiFontSize?: number }) =>
    call<{ monoFont: string; terminalFontSize: number; uiFontSize: number }>("host.font", font),
  notify: (notice: { title: string; body: string }) => call<void>("host.notify", notice),
  tray: (summary: { title: string; lines: readonly string[] }) => call<void>("host.tray", summary),
  locale: (locale: string) => call<void>("host.locale", locale),
  reveal: (path: string) => call<void>("host.reveal", path),
  theme: (theme: "light" | "dark" | "system") => call<void>("host.theme", theme),
  motion: (choice: MotionChoice) => call<void>("host.motion", choice),
  opening: (opening: { phase: string; progress: number }) => call<void>("host.opening", opening),
  /** A terminal pane at `cwd` (a worktree, repo, session's or issue's directory), optionally running `command`. */
  openTerminal: (at: { cwd: string; title?: string; command?: string }) => call<{ terminalId: string }>("host.openTerminal", at),
  openUrl: (url: string) => call<void>("host.openUrl", { url }),
  /** Opens an existing absolute path in the system's default app. */
  openFile: (path: string) => call<void>("host.openFile", { path }),
  openWorktreeFile: (worktree: string, path: string) => call<void>("host.openFile", { worktree, path }),
  /** VibeValley's built pixel art: the folder with sprites.json and its PNGs. */
  pixelDir: () => call<{ path: string }>("host.pixelDir", {}),
  /** VibeValley's sprite manifest read from disk by Rust (`assets/pixel/sprites.json`). */
  pixelManifest: () => call<Record<string, unknown>>("host.pixelManifest", {}),
  /** SHA-256 hex digest of UTF-8 text computed in Rust. */
  sha256: (text: string) => call<{ hex: string }>("host.sha256", { text }),
  /** Cryptographic random bytes (hex-encoded) generated in Rust. */
  randomBytes: (length: number) => call<{ hex: string }>("host.randomBytes", { length }),
  /** Encodes UTF-8 text into a QR module grid (`'1'` dark / `'0'` light) in Rust. */
  qr: (text: string, border = 2) => call<{ size: number; rows: string[] }>("host.qr", { text, border }),
  /** Plays a local sound file (nsh's AudioPlayer is silent in the app); stops the last one. */
  playAudio: (path: string, position = 0) => call<void>("host.playAudio", { path, position }),
  seekAudio: (position: number) => call<void>("host.seekAudio", { position }),
  audioState: () => call<{ position: number; duration: number; playing: boolean }>("host.audioState"),
  pcmStart: (sampleRate: number, channels = 1) => call<void>("host.pcmStart", { sampleRate, channels }),
  pcmAppend: (data: string) => call<void>("host.pcmAppend", { data }),
  /** Plays a named UI sound synthesized and cached in Rust. */
  playSound: (name: string) => call<void>("host.playSound", { name }),
  /** A dropped file's bytes (an absolute path or a file: URL; at most 50 MB). */
  readFile: (path: string) => call<{ data: string; type: string; name: string }>("host.readFile", { path }),
  cliState: () => call<CommandLineState>("host.cliState"),
  cliInstall: () => call<CommandLineState>("host.cliInstall"),
  cliRemove: () => call<CommandLineState>("host.cliRemove"),
  stopAudio: () => call<void>("host.stopAudio", {}),
};

export type Action = { type: string; [key: string]: unknown };

/** Intent for the shell (VibeValley's own panels): open a file, stage, switch project... */
export function act(action: Action): void {
  if (!host.available()) return;
  host.post("action", action);
}

/** Which surface this view shows (set by Rust before the bundle loads). */
export function viewName(): string {
  return readHostViewName();
}
