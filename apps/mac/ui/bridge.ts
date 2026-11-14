// The Rust <-> TSX bridge (Rust side: crates/vibevalley-bridge, apps/mac/src/hosted).
//
// Server traffic, in VibeValley's shapes:
//   call(op, payload)            -> Promise<Envelope>        (action "call", event "reply:<id>")
//   frame("state")               -> latest StateFrame        (action "watch", events "frame:state")
//   frame("live") / onLive(fn)   -> LiveEvents               (action "watch", events "frame:live")
//   subscribe(name, payload, on, ended) -> stop              (actions "subscribe"/"unsubscribe", events "sub:<id>")
// Host capabilities (VibeValley's packages/protocol/src/host.ts, plus the terminal):
//   hostApi.notify / tray / locale / reveal / theme / opening / openTerminal / openUrl / openFile / pixelDir / info
//   = call("host.<name>", payload), answered by the shell.
// Shell frames and actions (VibeValley's own panels): frame(<topic>) for topics Rust pushes,
// act({ type, ... }) for intent back.
import { host, signal, type Signal } from "nsh";

export type Next = { say: string; run?: readonly string[] };
export type ErrorDetail = { next?: readonly Next[]; settings?: string };
/** VibeValley's response envelope. `bizCode` 0 is success. */
export type Envelope<T = unknown> = { bizCode: number; message: string; data?: T; error?: ErrorDetail };

/** Envelope codes the bridge itself produces (VibeValley's BizCode values). */
export const BridgeCode = { Ok: 0, ServiceUnavailable: 100009 } as const;

let counter = 0;
const nextId = () => `${Date.now().toString(36)}.${(++counter).toString(36)}`;

/** One endpoint by name. Never rejects: failures are envelopes with a non-zero bizCode. */
export function call<T = unknown>(op: string, payload: unknown = null, options?: { timeoutMs?: number }): Promise<Envelope<T>> {
  return new Promise((resolve) => {
    if (!host.available()) {
      resolve({ bizCode: BridgeCode.ServiceUnavailable, message: "no host to answer this call" });
      return;
    }
    const id = nextId();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = host.on(`reply:${id}`, (envelope) => {
      stop();
      if (timer !== undefined) clearTimeout(timer);
      resolve(envelope as unknown as Envelope<T>);
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

/** An envelope's data, or a thrown error carrying the envelope (for code written against throwing clients). */
export class BridgeError extends Error {
  constructor(readonly envelope: Envelope) {
    super(envelope.message);
  }
  get bizCode(): number {
    return this.envelope.bizCode;
  }
}

export async function unwrap<T>(pending: Promise<Envelope<T>>): Promise<T> {
  const envelope = await pending;
  if (envelope.bizCode !== 0) throw new BridgeError(envelope);
  return envelope.data as T;
}

export type FrameEnvelope<T> = { rev: number; data: T };

const topics = new Map<string, Signal<FrameEnvelope<unknown> | null>>();
/** Topics the server streams; the view asks for them once, on first use. */
const serverTopics = new Set(["state", "live"]);

function topic(name: string): Signal<FrameEnvelope<unknown> | null> {
  let s = topics.get(name);
  if (s) return s;
  const store = signal<FrameEnvelope<unknown> | null>(null);
  topics.set(name, store);
  s = store;
  host.on(`frame:${name}`, (payload) => {
    const env = payload as unknown as FrameEnvelope<unknown>;
    store.set(env);
    // Rust's debug dump records what each view applied; the live stream is too chatty for that.
    if (name !== "live") host.post("action", { type: "applied", topic: name, rev: env.rev });
  });
  if (serverTopics.has(name) && host.available()) host.post("action", { type: "watch", topic: name });
  return s;
}

/** The latest frame of `name` (reactive), `null` until the first one. `frame("state")` is the StateFrame. */
export function frame<T>(name: string): () => T | null {
  const s = topic(name);
  return () => (s()?.data as T | undefined) ?? null;
}

/** The frame's revision (reactive): goes up by one per frame this view received. */
export function frameRev(name: string): () => number {
  const s = topic(name);
  return () => s()?.rev ?? 0;
}

/** Every LiveEvent from now on. Returns how to stop listening. */
export function onLive(listener: (event: unknown) => void): () => void {
  topic("live");
  return host.on("frame:live", (payload) => listener((payload as unknown as FrameEnvelope<unknown>).data));
}

/** One of rpc.ts's subscriptions (`channel.follow`, ...). `ended` gets `null` when the server ended it,
 * or the refusal's envelope. Returns how to stop it. */
export function subscribe<E = unknown>(name: string, payload: unknown, on: (event: E) => void, ended?: (why: Envelope | null) => void): () => void {
  const id = nextId();
  let open = true;
  const off = host.on(`sub:${id}`, (message) => {
    const m = message as unknown as { event?: E; end?: Envelope | null };
    if ("end" in m) {
      open = false;
      off();
      ended?.(m.end ?? null);
    } else {
      on(m.event as E);
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
      capabilities: string[];
    }>("host.info"),
  font: (font: { monoFont?: string; terminalFontSize?: number; uiFontSize?: number }) =>
    call<{ monoFont: string; terminalFontSize: number; uiFontSize: number }>("host.font", font),
  notify: (notice: { title: string; body: string }) => call<void>("host.notify", notice),
  tray: (summary: { title: string; lines: readonly string[] }) => call<void>("host.tray", summary),
  locale: (locale: string) => call<void>("host.locale", locale),
  reveal: (path: string) => call<void>("host.reveal", path),
  theme: (theme: "light" | "dark" | "system") => call<void>("host.theme", theme),
  opening: (opening: { phase: string; progress: number }) => call<void>("host.opening", opening),
  /** A terminal pane at `cwd` (a worktree, repo, session's or issue's directory), optionally running `command`. */
  openTerminal: (at: { cwd: string; title?: string; command?: string }) => call<{ terminalId: string }>("host.openTerminal", at),
  openUrl: (url: string) => call<void>("host.openUrl", { url }),
  /** Opens an existing absolute path in the system's default app. */
  openFile: (path: string) => call<void>("host.openFile", { path }),
  /** VibeValley's built pixel art: the folder with sprites.json and its PNGs. */
  pixelDir: () => call<{ path: string }>("host.pixelDir", {}),
  /** Plays a local sound file (nsh's AudioPlayer is silent in the app); stops the last one. */
  playAudio: (path: string, position = 0) => call<void>("host.playAudio", { path, position }),
  seekAudio: (position: number) => call<void>("host.seekAudio", { position }),
  audioState: () => call<{ position: number; duration: number; playing: boolean }>("host.audioState"),
  pcmStart: (sampleRate: number, channels = 1) => call<void>("host.pcmStart", { sampleRate, channels }),
  pcmAppend: (data: string) => call<void>("host.pcmAppend", { data }),
  /** Plays a sound made in the view (base64, e.g. a synthesised WAV of at most 2 MB). */
  playAudioData: (data: string, type = "audio/wav") => call<void>("host.playAudio", { data, type }),
  /** A dropped file's bytes (an absolute path or a file: URL; at most 50 MB). */
  readFile: (path: string) => call<{ data: string; type: string; name: string }>("host.readFile", { path }),
  cliState: () => call<import("@vibevalley/protocol/host").CommandLineState>("host.cliState"),
  cliInstall: () => call<import("@vibevalley/protocol/host").CommandLineState>("host.cliInstall"),
  cliRemove: () => call<import("@vibevalley/protocol/host").CommandLineState>("host.cliRemove"),
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
  return String(host.params.view ?? "stories");
}

export function param<T>(name: string, fallback: T): T {
  return (host.params[name] as T | undefined) ?? fallback;
}
