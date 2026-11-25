// Rust side: crates/server/src/transport/bridge, apps/mac/src/hosted; action and event names must match there.
import { cleanup, host, signal, type Signal } from "nsh";
import { z } from "zod";

import type { ConnectionSaveRequest, Envelope, SliceKind, SliceMap } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";
import { CommandLineState, MotionChoice, ThemeChoice } from "@vibevalley/protocol/host";
import { DesktopConnectionSnapshot as DesktopConnectionSnapshotSchema, EnvelopeSchema, sliceDecoders } from "@vibevalley/protocol/schema";

import { readHostViewName } from "./hostParams";

export type { Envelope };

export type Decoder<T> = {
  readonly safeParse: (input: unknown) => { readonly success: true; readonly data: T } | { readonly success: false };
};

let counter = 0;
const nextId = () => `${Date.now().toString(36)}.${(++counter).toString(36)}`;

const FrameEnvelopeSchema = z.object({
  rev: z.number(),
  data: z.unknown(),
});

const EndEnvelopeSchema = EnvelopeSchema.nullable();

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
export function call(op: string, payload: unknown = null, options?: { timeoutMs?: number }): Promise<Envelope> {
  return new Promise((resolve) => {
    if (!host.available()) {
      resolve({ bizCode: BizCode.ServiceUnavailable, message: "no host to answer this call" });
      return;
    }
    const id = nextId();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = listenDetached(`reply:${id}`, (envelope) => {
      stop();
      if (timer !== undefined) clearTimeout(timer);
      const parsed = EnvelopeSchema.safeParse(envelope);
      if (parsed.success) {
        resolve(parsed.data);
      } else {
        resolve({ bizCode: BizCode.ServiceUnavailable, message: `${op}: invalid bridge envelope` });
      }
    });
    if (options?.timeoutMs !== undefined && Number.isFinite(options.timeoutMs)) {
      timer = setTimeout(() => {
        stop();
        resolve({ bizCode: BizCode.ServiceUnavailable, message: `${op}: no answer in ${options.timeoutMs} ms` });
      }, options.timeoutMs);
    }
    host.post("action", { type: "call", id, op, payload });
  });
}

/** One endpoint by name whose `data` payload is decoded at the bridge boundary with `decoder`. */
export async function callDecoded<T>(op: string, payload: unknown, decoder: Decoder<T>, options?: { timeoutMs?: number }): Promise<Envelope<T>> {
  const env = await call(op, payload, options);
  if (env.bizCode !== BizCode.Ok) {
    return { bizCode: env.bizCode, message: env.message, ...(env.error !== undefined ? { error: env.error } : {}) };
  }
  const parsed = decoder.safeParse(env.data);
  if (!parsed.success) {
    return { bizCode: BizCode.ServiceUnavailable, message: `${op}: invalid bridge response payload` };
  }
  return { bizCode: env.bizCode, message: env.message, data: parsed.data, ...(env.error !== undefined ? { error: env.error } : {}) };
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
    const parsed = FrameEnvelopeSchema.safeParse(payload);
    if (!parsed.success) return;
    entry.latest = parsed.data;
    entry.store.set(parsed.data);
    // A slice receipt releases the next snapshot. Other non-live receipts feed the debug dump.
    if (name !== "live") host.post("action", { type: "applied", topic: name, rev: parsed.data.rev });
    for (const listener of [...entry.listeners]) listener(parsed.data.data);
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

/** A listener joining an active topic gets the newest cached frame at once. */
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

function cachedDecode<T>(readRaw: () => unknown, decoder: Decoder<T>): () => T | null {
  let hasLast = false;
  let lastRaw: unknown;
  let lastDecoded: T | null = null;
  return () => {
    const raw = readRaw();
    if (hasLast && raw === lastRaw) return lastDecoded;
    hasLast = true;
    lastRaw = raw;
    if (raw === undefined || raw === null) {
      lastDecoded = null;
      return null;
    }
    const parsed = decoder.safeParse(raw);
    lastDecoded = parsed.success ? parsed.data : null;
    return lastDecoded;
  };
}

/** `null` until the first frame arrives and decodes against `decoder`. */
export function frame<T>(name: string, decoder: Decoder<T>): () => T | null {
  if (isSliceTopic(name)) {
    const { entry, release } = acquireSlice(name);
    cleanup(release);
    return cachedDecode(() => entry.store()?.data, decoder);
  }
  const { store } = topic(name);
  return cachedDecode(() => store()?.data, decoder);
}

/** Reactive decoded slice reader backed by `@vibevalley/protocol`'s `sliceDecoders`. */
export function sliceFrame<K extends SliceKind>(kind: K): () => SliceMap[K] | null {
  return frame(`${SLICE_PREFIX}${kind}`, sliceDecoders[kind]);
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

/** One of api.ts's subscriptions (`channel.follow`, ...). `ended` gets `null` when the server ended it,
 * or the refusal's envelope. Returns how to stop it. */
export function subscribe(name: string, payload: unknown, on: (event: unknown) => void, ended?: (why: Envelope | null) => void): () => void {
  const id = nextId();
  let open = true;
  const off = listenDetached(`sub:${id}`, (message) => {
    if (!open || typeof message !== "object" || message === null) return;
    if ("end" in message) {
      open = false;
      off();
      const parsedEnd = EndEnvelopeSchema.safeParse(message.end);
      ended?.(parsedEnd.success ? parsedEnd.data : null);
    } else if ("event" in message) {
      on(message.event);
    } else {
      on(undefined);
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

const HostInfoSchema = z.object({
  name: z.exactOptional(z.string()),
  version: z.exactOptional(z.string()),
  titleBar: z.exactOptional(z.object({ top: z.number(), left: z.number() }).nullable()),
  terminal: z.exactOptional(z.boolean()),
  theme: z.exactOptional(ThemeChoice),
  monoFont: z.exactOptional(z.string()),
  monoFonts: z.exactOptional(z.array(z.string())),
  terminalFontSize: z.exactOptional(z.number()),
  uiFontSize: z.exactOptional(z.number()),
  motion: z.exactOptional(MotionChoice),
  capabilities: z.exactOptional(z.array(z.string())),
});

const HostFontSchema = z.object({
  monoFont: z.string(),
  terminalFontSize: z.number(),
  uiFontSize: z.number(),
});

const OpenTerminalSchema = z.object({ terminalId: z.string() });
const PixelDirSchema = z.object({ path: z.string() });
const PickFileSchema = z.object({ path: z.string(), name: z.string(), type: z.string() }).nullable();
const ReadFileSchema = z.object({ data: z.string(), type: z.string(), name: z.string() });

/** The host's capabilities (packages/protocol's Host, desktop flavour) and the terminal. */
export const hostApi = {
  connectionState: () => callDecoded("host.connectionState", {}, DesktopConnectionSnapshotSchema),
  connectionSave: (input: ConnectionSaveRequest) => callDecoded("host.connectionSave", input, DesktopConnectionSnapshotSchema),
  connectionReset: () => callDecoded("host.connectionReset", {}, DesktopConnectionSnapshotSchema),
  info: () => callDecoded("host.info", null, HostInfoSchema),
  updateState: () => call("host.updateState", null, { timeoutMs: 5_000 }),
  updateCheck: () => call("host.updateCheck"),
  updateInstall: () => call("host.updateInstall"),
  font: (font: { monoFont?: string; terminalFontSize?: number; uiFontSize?: number }) => callDecoded("host.font", font, HostFontSchema),
  notify: (notice: { title: string; body: string }) => call("host.notify", notice),
  tray: (summary: { title: string; lines: readonly string[] }) => call("host.tray", summary),
  locale: (locale: string) => call("host.locale", locale),
  reveal: (path: string) => call("host.reveal", path),
  theme: (theme: "light" | "dark" | "system") => call("host.theme", theme),
  motion: (choice: MotionChoice) => call("host.motion", choice),
  opening: (opening: { phase: string; progress: number }) => call("host.opening", opening),
  /** A terminal pane at `cwd` (a worktree, repo, session's or issue's directory), optionally running `command`. */
  openTerminal: (at: { cwd: string; title?: string; command?: string }) => callDecoded("host.openTerminal", at, OpenTerminalSchema),
  openUrl: (url: string) => call("host.openUrl", { url }),
  /** Opens an existing absolute path in the system's default app. */
  openFile: (path: string) => call("host.openFile", { path }),
  openWorktreeFile: (worktree: string, path: string) => call("host.openFile", { worktree, path }),
  /** VibeValley's built pixel art: the folder with sprites.json and its PNGs. */
  pixelDir: () => callDecoded("host.pixelDir", {}, PixelDirSchema),
  /** Plays a named UI sound synthesized and cached in Rust. */
  playSound: (name: string) => call("host.playSound", { name }),
  /** Opens the native file picker and returns the chosen path, or null when canceled. */
  pickFile: () => callDecoded("host.pickFile", {}, PickFileSchema),
  /** A dropped or picked file's bytes (an absolute path or a file: URL; at most 50 MB). */
  readFile: (path: string) => callDecoded("host.readFile", { path }, ReadFileSchema),
  cliState: () => callDecoded("host.cliState", null, CommandLineState),
  cliInstall: () => callDecoded("host.cliInstall", null, CommandLineState),
  cliRemove: () => callDecoded("host.cliRemove", null, CommandLineState),
  stopAudio: () => call("host.stopAudio", {}),
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
