import { VibeValleyApiError } from "../client";
import { BoardSlice, CollabSlice, InboxSlice, LiveEvent, OpsSlice, SessionsSlice } from "../core/schema";
import type {
  BoardSlice as BoardSliceShape,
  CollabSlice as CollabSliceShape,
  InboxSlice as InboxSliceShape,
  LiveEvent as LiveEventShape,
  OpsSlice as OpsSliceShape,
  SessionsSlice as SessionsSliceShape,
  SliceKind,
} from "../core/shapes";
import { ApiErrorEnvelope, apiSuccessEnvelope, BizCode, bizCodeMeta, pathOf } from "../endpoint";
import { FarmFrame } from "../game/schema";
import type { FarmFrame as FarmFrameShape } from "../game/shapes.gen";
import { RemotePairExchangeResult } from "./schema";
import type { RemotePairExchangeRequest, RemotePairExchangeResult as RemotePairExchangeResultShape } from "./shapes.gen";

export type RemoteConnectionState = "connecting" | "connected" | "reconnecting" | "unauthorized" | "offline";

export interface ParsedPairUrl {
  readonly url: string;
  readonly code: string;
}

export interface RemoteEnvelope {
  readonly bizCode: number;
  readonly message: string;
  readonly data?: unknown;
  readonly error?: unknown;
}

export interface RemoteSliceMap {
  readonly board: BoardSliceShape;
  readonly sessions: SessionsSliceShape;
  readonly collab: CollabSliceShape;
  readonly inbox: InboxSliceShape;
  readonly ops: OpsSliceShape;
  readonly farm: FarmFrameShape;
}

export interface HttpRemoteTransportOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly onConnectionChange?: (state: RemoteConnectionState) => void;
}

export interface HttpRemoteTransport {
  readonly call: (op: string, payload?: unknown, options?: { readonly signal?: AbortSignal }) => Promise<RemoteEnvelope>;
  readonly slice: <K extends SliceKind>(kind: K, listener: (data: RemoteSliceMap[K]) => void) => () => void;
  readonly live: (listener: (event: LiveEventShape) => void) => () => void;
  readonly subscribe: (name: string, payload: unknown, on: (event: unknown) => void, ended: (why: RemoteEnvelope | null) => void) => () => void;
  readonly close: () => void;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000] as const;
const REMOTE_CLIENT_HEADER = "remote";
const pairResultEnvelope = apiSuccessEnvelope(RemotePairExchangeResult);

type SliceDecoder<K extends SliceKind> = (raw: unknown) => RemoteSliceMap[K] | undefined;

function decodeWith<T>(schema: {
  readonly safeParse: (input: unknown) => { readonly success: true; readonly data: T } | { readonly success: false };
}): (raw: unknown) => T | undefined {
  return (raw) => {
    const parsed = schema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  };
}

const sliceDecoders: { readonly [K in SliceKind]: SliceDecoder<K> } = {
  board: decodeWith(BoardSlice),
  sessions: decodeWith(SessionsSlice),
  collab: decodeWith(CollabSlice),
  inbox: decodeWith(InboxSlice),
  ops: decodeWith(OpsSlice),
  farm: decodeWith(FarmFrame),
};

const isRecord = (u: unknown): u is Record<string, unknown> => typeof u === "object" && u !== null;

const parseJsonSafe = (text: string): unknown => {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

function toEnvelope(raw: unknown): RemoteEnvelope | undefined {
  if (!isRecord(raw) || typeof raw.bizCode !== "number" || typeof raw.message !== "string") return undefined;
  return {
    bizCode: raw.bizCode,
    message: raw.message,
    ...("data" in raw && raw.data !== undefined ? { data: raw.data } : {}),
    ...("error" in raw && raw.error !== undefined ? { error: raw.error } : {}),
  };
}

function fallbackBizCode(status: number): number {
  if (status === 401) return BizCode.Unauthorized;
  if (status === 403) return BizCode.Forbidden;
  if (status === 404) return BizCode.RouteNotFound;
  if (status === 503) return BizCode.ServiceUnavailable;
  return BizCode.InternalError;
}

function decodeApiErrorOrThrow(status: number, raw: unknown, text: string): VibeValleyApiError {
  const env = ApiErrorEnvelope.safeParse(raw);
  if (env.success) {
    const meta = bizCodeMeta[env.data.bizCode];
    return new VibeValleyApiError(status === 200 ? meta.status : status, meta.kind, env.data.message, env.data.error, text, env.data.bizCode);
  }
  const reason = isRecord(raw) && typeof raw.message === "string" && raw.message !== "" ? raw.message : text.trim() || `HTTP ${status}`;
  return new VibeValleyApiError(status, undefined, reason, undefined, text);
}

/** Normalizes a Mac server address: trims whitespace and trailing slashes, and prepends `http://` to bare `host:port`. */
export function normalizeServerUrl(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  const withScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//u.test(trimmed) ? trimmed : `http://${trimmed}`;
  return withScheme.replace(/\/+$/u, "");
}

/** Parses `vibevalley://pair?url=<http|https>&code=<code>`, rejecting other schemes or blank codes. */
export function parsePairUrl(raw: string): ParsedPairUrl | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol.toLowerCase() !== "vibevalley:") return null;
  if (parsed.host.toLowerCase() !== "pair") return null;
  if (parsed.pathname !== "" && parsed.pathname !== "/") return null;

  const urlParam = parsed.searchParams.get("url")?.trim() ?? "";
  const code = parsed.searchParams.get("code")?.trim() ?? "";
  if (!urlParam || !code) return null;

  let target: URL;
  try {
    target = new URL(urlParam);
  } catch {
    return null;
  }
  if ((target.protocol !== "http:" && target.protocol !== "https:") || target.host === "") return null;

  return {
    url: normalizeServerUrl(urlParam),
    code,
  };
}

/** Exchanges a one-time pairing code for a persistent Bearer device token via `POST /api/v1/remote/pair/exchange`. */
export async function pairWithServer(
  baseUrl: string,
  req: RemotePairExchangeRequest,
  fetchImpl: typeof fetch = fetch,
  options?: { readonly signal?: AbortSignal },
): Promise<RemotePairExchangeResultShape> {
  const base = normalizeServerUrl(baseUrl);
  const res = await fetchImpl(`${base}${pathOf("remote.pair.exchange")}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-vibevalley-client": REMOTE_CLIENT_HEADER,
    },
    body: JSON.stringify(req),
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  const text = await res.text();
  const parsed = parseJsonSafe(text);
  if (!res.ok) {
    throw decodeApiErrorOrThrow(res.status, parsed, text);
  }
  const checked = pairResultEnvelope.safeParse(parsed);
  if (!checked.success) {
    const errEnv = ApiErrorEnvelope.safeParse(parsed);
    if (errEnv.success) {
      const meta = bizCodeMeta[errEnv.data.bizCode];
      throw new VibeValleyApiError(meta.status, meta.kind, errEnv.data.message, errEnv.data.error, text, errEnv.data.bizCode);
    }
    if (isRecord(parsed) && typeof parsed.bizCode === "number" && parsed.bizCode !== 0) {
      const reason = typeof parsed.message === "string" && parsed.message !== "" ? parsed.message : `HTTP ${res.status}`;
      throw new VibeValleyApiError(500, undefined, reason, undefined, text);
    }
    throw new Error(`remote.pair.exchange: invalid response shape: ${checked.error.message}`);
  }
  return checked.data.data;
}

interface SseMessage {
  readonly id: string | undefined;
  readonly data: string;
}

async function readSseStream(body: ReadableStream<Uint8Array>, signal: AbortSignal, onMessage: (msg: SseMessage) => void): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let cancelPending: Promise<void> | undefined;
  const onAbort = () => {
    cancelPending = reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", onAbort, { once: true });

  let buffer = "";
  let skipLeadingLf = false;
  let lastEventId: string | undefined;
  let dataLines: string[] = [];

  const handleLine = (line: string) => {
    if (line === "") {
      if (dataLines.length > 0) {
        const data = dataLines.join("\n");
        dataLines = [];
        onMessage({ id: lastEventId, data });
      }
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "data") {
      dataLines.push(value);
    } else if (field === "id" && !value.includes("\0")) {
      lastEventId = value;
    }
  };

  const drainLines = (text: string) => {
    let chunk = text;
    if (skipLeadingLf && chunk.startsWith("\n")) {
      chunk = chunk.slice(1);
      skipLeadingLf = false;
    } else if (chunk.length > 0) {
      skipLeadingLf = false;
    }
    buffer += chunk;

    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const ch = buffer[i];
      if (ch === "\n") {
        handleLine(buffer.slice(start, i));
        start = i + 1;
      } else if (ch === "\r") {
        handleLine(buffer.slice(start, i));
        if (i + 1 < buffer.length) {
          if (buffer[i + 1] === "\n") i++;
          start = i + 1;
        } else {
          // A CR at the end of a chunk may be followed by LF in the next chunk.
          skipLeadingLf = true;
          start = i + 1;
        }
      }
    }
    buffer = buffer.slice(start);
  };

  try {
    while (!signal.aborted) {
      const step = await reader.read();
      if (step.done) {
        const rest = decoder.decode();
        if (rest.length > 0) drainLines(rest);
        break;
      }
      if (step.value.byteLength > 0) {
        drainLines(decoder.decode(step.value, { stream: true }));
      }
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
    if (cancelPending !== undefined) await cancelPending;
    else await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function combineSignals(parent: AbortSignal, child?: AbortSignal): { readonly signal: AbortSignal; readonly cleanup: () => void } {
  if (!child) return { signal: parent, cleanup: () => {} };
  const controller = new AbortController();
  const abortFrom = (source: AbortSignal) => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  if (parent.aborted) {
    abortFrom(parent);
    return { signal: controller.signal, cleanup: () => {} };
  }
  if (child.aborted) {
    abortFrom(child);
    return { signal: controller.signal, cleanup: () => {} };
  }
  const onParent = () => abortFrom(parent);
  const onChild = () => abortFrom(child);
  parent.addEventListener("abort", onParent, { once: true });
  child.addEventListener("abort", onChild, { once: true });
  return {
    signal: controller.signal,
    cleanup: () => {
      parent.removeEventListener("abort", onParent);
      child.removeEventListener("abort", onChild);
    },
  };
}

/** Pure Web-Fetch HTTP + SSE transport for remote mobile clients with Bearer auth and `Last-Event-ID` resync. */
export function createHttpRemoteTransport(options: HttpRemoteTransportOptions): HttpRemoteTransport {
  const base = normalizeServerUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? fetch;
  const token = options.token;
  const master = new AbortController();
  const controllers = new Set<AbortController>();
  const tasks = new Set<Promise<void>>();

  let closed = false;
  let unauthorized = false;
  let connectionState: RemoteConnectionState | undefined;
  let connectedStreams = 0;

  const reportState = (next: RemoteConnectionState) => {
    if (connectionState === next) return;
    connectionState = next;
    options.onConnectionChange?.(next);
  };

  const markUnauthorized = () => {
    unauthorized = true;
    reportState("unauthorized");
  };

  const authHeaders = (extra?: Readonly<Record<string, string>>): Record<string, string> => ({
    authorization: `Bearer ${token}`,
    "x-vibevalley-client": REMOTE_CLIENT_HEADER,
    ...extra,
  });

  const trackStream = (run: (signal: AbortSignal) => Promise<void>): (() => void) => {
    if (closed || unauthorized) return () => {};
    const controller = new AbortController();
    controllers.add(controller);
    const onMasterAbort = () => {
      if (!controller.signal.aborted) controller.abort(master.signal.reason);
    };
    master.signal.addEventListener("abort", onMasterAbort, { once: true });

    const task = run(controller.signal)
      .catch(() => undefined)
      .finally(() => {
        master.signal.removeEventListener("abort", onMasterAbort);
        controllers.delete(controller);
        tasks.delete(task);
      });
    tasks.add(task);

    return () => {
      if (!controller.signal.aborted) controller.abort();
    };
  };

  const call: HttpRemoteTransport["call"] = async (op, payload, callOptions) => {
    const combined = combineSignals(master.signal, callOptions?.signal);
    try {
      const hasPayload = payload !== undefined;
      const res = await fetchImpl(`${base}${pathOf(op)}`, {
        method: "POST",
        headers: authHeaders(hasPayload ? { "content-type": "application/json" } : undefined),
        ...(hasPayload ? { body: JSON.stringify(payload) } : {}),
        signal: combined.signal,
      });
      if (res.status === 401) {
        markUnauthorized();
      }
      const text = await res.text();
      const parsed = parseJsonSafe(text);
      const envelope = toEnvelope(parsed);
      if (envelope) return envelope;
      if (!res.ok) {
        return {
          bizCode: fallbackBizCode(res.status),
          message: text.trim() || `HTTP ${res.status}`,
        };
      }
      throw new Error(`${op}: invalid envelope response`);
    } finally {
      combined.cleanup();
    }
  };

  const runReconnectableSse = async (
    signal: AbortSignal,
    url: string,
    getLastEventId: () => string | undefined,
    onEvent: (msg: SseMessage) => void,
  ): Promise<void> => {
    let attempt = 0;
    if (connectedStreams === 0 && !unauthorized) {
      reportState("connecting");
    }

    while (!signal.aborted && !closed && !unauthorized) {
      let wasConnected = false;
      try {
        const lastId = getLastEventId();
        const res = await fetchImpl(url, {
          method: "GET",
          headers: authHeaders({
            accept: "text/event-stream",
            ...(lastId ? { "last-event-id": lastId } : {}),
          }),
          signal,
        });

        if (res.status === 401 || res.status === 403) {
          markUnauthorized();
          return;
        }
        if (res.ok && res.body) {
          attempt = 0;
          wasConnected = true;
          connectedStreams++;
          reportState("connected");
          await readSseStream(res.body, signal, (msg) => {
            if (!signal.aborted && !closed) onEvent(msg);
          });
        }
      } catch {
        // Network drops and aborts fall through to the reconnect check below.
      } finally {
        if (wasConnected) {
          connectedStreams = Math.max(0, connectedStreams - 1);
        }
      }

      if (signal.aborted || closed || unauthorized) return;
      reportState("reconnecting");
      const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 8000;
      attempt++;
      const waited = await abortableDelay(delay, signal);
      if (!waited) return;
    }
  };

  const slice: HttpRemoteTransport["slice"] = (kind, listener) => {
    const decode = sliceDecoders[kind];
    let lastEventId: string | undefined;
    return trackStream(async (signal) => {
      await runReconnectableSse(
        signal,
        `${base}/api/v1/slice/${encodeURIComponent(kind)}`,
        () => lastEventId,
        (msg) => {
          if (msg.id) lastEventId = msg.id;
          const parsed = parseJsonSafe(msg.data);
          const decoded = decode(parsed);
          if (decoded === undefined) return;
          if (!msg.id) lastEventId = String(decoded.seq);
          listener(decoded);
        },
      );
    });
  };

  const live: HttpRemoteTransport["live"] = (listener) =>
    trackStream(async (signal) => {
      await runReconnectableSse(
        signal,
        `${base}/api/v1/live`,
        () => undefined,
        (msg) => {
          const parsed = parseJsonSafe(msg.data);
          const decoded = LiveEvent.safeParse(parsed);
          if (decoded.success) listener(decoded.data);
        },
      );
    });

  const subscribe: HttpRemoteTransport["subscribe"] = (name, payload, on, ended) => {
    let finished = false;
    return trackStream(async (signal) => {
      const finish = (why: RemoteEnvelope | null) => {
        if (finished || signal.aborted || closed) return;
        finished = true;
        ended(why);
      };

      try {
        const query = encodeURIComponent(JSON.stringify(payload ?? {}));
        const res = await fetchImpl(`${base}/api/v1/subscribe/${encodeURIComponent(name)}?payload=${query}`, {
          method: "GET",
          headers: authHeaders({ accept: "text/event-stream" }),
          signal,
        });
        if (res.status === 401) {
          markUnauthorized();
        }
        const contentType = res.headers.get("content-type") ?? "";
        if (!res.ok || contentType.includes("application/json")) {
          const text = await res.text();
          const parsed = parseJsonSafe(text);
          const env = toEnvelope(parsed) ?? {
            bizCode: fallbackBizCode(res.status),
            message: text.trim() || `HTTP ${res.status}`,
          };
          finish(env);
          return;
        }
        if (!res.body) {
          finish(null);
          return;
        }
        await readSseStream(res.body, signal, (msg) => {
          if (signal.aborted || closed) return;
          const parsed = parseJsonSafe(msg.data);
          if (parsed !== undefined) on(parsed);
        });
        finish(null);
      } catch (err: unknown) {
        if (signal.aborted || closed) return;
        finish({
          bizCode: BizCode.ServiceUnavailable,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    });
  };

  const close = () => {
    if (closed) return;
    closed = true;
    if (!master.signal.aborted) master.abort();
    for (const controller of controllers) {
      if (!controller.signal.aborted) controller.abort();
    }
    controllers.clear();
    if (!unauthorized) {
      reportState("offline");
    }
  };

  return { call, slice, live, subscribe, close };
}
