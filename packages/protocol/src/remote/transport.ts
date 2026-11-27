import { z } from "zod";

import { VibeValleyApiError } from "../client";
import { LiveEvent, sliceDecoders } from "../core/schema";
import type { LiveEvent as LiveEventShape, SliceKind, SliceMap } from "../core/shapes";
import { ApiErrorEnvelope, apiSuccessEnvelope, BizCode, bizCodeMeta, type Envelope, EnvelopeSchema, pathOf } from "../endpoint";
import { RemotePairExchangeResult } from "./schema";
import type { RemotePairExchangeRequest, RemotePairExchangeResult as RemotePairExchangeResultShape } from "./shapes.gen";

export type RemoteConnectionState = "connecting" | "connected" | "reconnecting" | "unauthorized" | "offline";

export interface ParsedPairUrl {
  readonly url: string;
  readonly code: string;
}

export type RemoteEnvelope = Envelope;

export type RemoteSliceMap = SliceMap;

export interface RemoteDecodeError {
  readonly stream: "slice" | "live" | "subscribe";
  readonly topic: string;
  readonly reason: string;
  readonly raw: string;
}

export interface HttpRemoteTransportOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetch?: typeof fetch;
  readonly onConnectionChange?: (state: RemoteConnectionState) => void;
  readonly onDecodeError?: (error: RemoteDecodeError) => void;
}

export interface HttpRemoteTransport {
  readonly call: (op: string, payload?: unknown, options?: { readonly signal?: AbortSignal }) => Promise<RemoteEnvelope>;
  readonly slice: <K extends SliceKind>(kind: K, listener: (data: RemoteSliceMap[K]) => void) => () => void;
  readonly live: (listener: (event: LiveEventShape) => void) => () => void;
  readonly subscribe: (name: string, payload: unknown, on: (event: unknown) => void, ended: (why: RemoteEnvelope | null) => void) => () => void;
  readonly suspend: () => void;
  readonly resume: () => void;
  readonly close: () => void;
}

const BACKOFF_MS = [1000, 2000, 4000, 8000] as const;
const REMOTE_CLIENT_HEADER = "remote";
const pairResultEnvelope = apiSuccessEnvelope(RemotePairExchangeResult);

const MessageEnvelopeSchema = z.object({
  message: z.string().min(1),
});

const parseJsonSafe = (text: string): unknown => {
  if (text === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

function toEnvelope(raw: unknown): RemoteEnvelope | undefined {
  const parsed = EnvelopeSchema.safeParse(raw);
  return parsed.success ? parsed.data : undefined;
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
  const msg = MessageEnvelopeSchema.safeParse(raw);
  const reason = msg.success ? msg.data.message : text.trim() || `HTTP ${status}`;
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

function createAbortError(): Error {
  if (typeof DOMException === "function") {
    return new DOMException("The operation was aborted.", "AbortError");
  }
  const err = new Error("The operation was aborted.");
  err.name = "AbortError";
  return err;
}

/** Exchanges a one-time pairing code for a persistent Bearer device token via `POST /api/v1/remote/pair/exchange`. */
export async function pairWithServer(
  baseUrl: string,
  req: RemotePairExchangeRequest,
  fetchImpl: typeof fetch = fetch,
  options?: { readonly signal?: AbortSignal },
): Promise<RemotePairExchangeResultShape> {
  if (options?.signal?.aborted === true) {
    throw createAbortError();
  }
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
    if (ApiErrorEnvelope.safeParse(parsed).success) {
      throw decodeApiErrorOrThrow(200, parsed, text);
    }
    const rawEnv = toEnvelope(parsed);
    if (rawEnv && rawEnv.bizCode !== 0) {
      const reason = rawEnv.message !== "" ? rawEnv.message : `HTTP ${res.status}`;
      throw new VibeValleyApiError(500, undefined, reason, undefined, text);
    }
    throw new Error(`remote.pair.exchange: invalid response shape: ${checked.error.message}`);
  }
  return checked.data.data;
}

interface SseMessage {
  readonly id: string | undefined;
  readonly event: string | undefined;
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
  let eventType: string | undefined;
  let dataLines: string[] = [];

  const handleLine = (line: string) => {
    if (line === "") {
      if (dataLines.length > 0) {
        const data = dataLines.join("\n");
        const event = eventType;
        dataLines = [];
        eventType = undefined;
        onMessage({ id: lastEventId, event, data });
      } else {
        eventType = undefined;
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
    } else if (field === "event") {
      eventType = value;
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

function createCoalescedBackoff() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let deadline = 0;
  const waiters = new Set<(completed: boolean) => void>();

  const schedule = (targetDeadline: number) => {
    if (timer !== undefined) clearTimeout(timer);
    deadline = targetDeadline;
    const delay = Math.max(0, deadline - Date.now());
    timer = setTimeout(() => {
      timer = undefined;
      deadline = 0;
      const pending = [...waiters];
      waiters.clear();
      for (const resolve of pending) resolve(true);
    }, delay);
  };

  const wait = (ms: number, signal: AbortSignal): Promise<boolean> => {
    if (signal.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const target = Date.now() + ms;
      const onAbort = () => {
        waiters.delete(done);
        if (waiters.size === 0 && timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
          deadline = 0;
        }
        resolve(false);
      };
      const done = (completed: boolean) => {
        signal.removeEventListener("abort", onAbort);
        resolve(completed);
      };
      waiters.add(done);
      signal.addEventListener("abort", onAbort, { once: true });
      if (timer === undefined || target < deadline) {
        schedule(target);
      }
    });
  };

  const cancelAll = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
      deadline = 0;
    }
    const pending = [...waiters];
    waiters.clear();
    for (const resolve of pending) resolve(false);
  };

  return { wait, cancelAll };
}

function combineSignals(parent: AbortSignal, child?: AbortSignal): { readonly signal: AbortSignal; readonly cleanup: () => void } {
  if (!child) return { signal: parent, cleanup: () => {} };
  if (parent.aborted) return { signal: parent, cleanup: () => {} };
  if (child.aborted) return { signal: child, cleanup: () => {} };
  const controller = new AbortController();
  const cleanup = () => {
    parent.removeEventListener("abort", onParent);
    child.removeEventListener("abort", onChild);
  };
  const abortFrom = (source: AbortSignal) => {
    cleanup();
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  const onParent = () => abortFrom(parent);
  const onChild = () => abortFrom(child);
  parent.addEventListener("abort", onParent, { once: true });
  child.addEventListener("abort", onChild, { once: true });
  return { signal: controller.signal, cleanup };
}

/** Pure Web-Fetch HTTP + SSE transport for remote mobile clients with Bearer auth and `Last-Event-ID` resync. */
export function createHttpRemoteTransport(options: HttpRemoteTransportOptions): HttpRemoteTransport {
  const base = normalizeServerUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? fetch;
  const token = options.token;
  const master = new AbortController();
  const controllers = new Set<AbortController>();
  const attemptControllers = new Set<AbortController>();
  const resumeWaiters = new Set<() => void>();
  const tasks = new Set<Promise<void>>();
  const backoff = createCoalescedBackoff();

  let closed = false;
  let unauthorized = false;
  let suspended = false;
  let resumeGeneration = 0;
  let connectionState: RemoteConnectionState | undefined;
  let connectedStreams = 0;

  const reportState = (next: RemoteConnectionState) => {
    if (connectionState === next) return;
    connectionState = next;
    options.onConnectionChange?.(next);
  };

  const abortActiveAttempts = () => {
    for (const controller of [...attemptControllers]) {
      if (!controller.signal.aborted) controller.abort();
    }
    attemptControllers.clear();
  };

  const releaseResumeWaiters = () => {
    for (const wake of [...resumeWaiters]) {
      wake();
    }
    resumeWaiters.clear();
  };

  const waitWhileSuspended = (signal: AbortSignal): Promise<boolean> => {
    if (!suspended) return Promise.resolve(!signal.aborted && !closed && !unauthorized);
    if (signal.aborted || closed || unauthorized) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const cleanup = () => {
        resumeWaiters.delete(onResume);
        signal.removeEventListener("abort", onAbort);
      };
      const onResume = () => {
        cleanup();
        resolve(!signal.aborted && !closed && !unauthorized && !suspended);
      };
      const onAbort = () => {
        cleanup();
        resolve(false);
      };
      resumeWaiters.add(onResume);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  };

  const markUnauthorized = () => {
    unauthorized = true;
    reportState("unauthorized");
    abortActiveAttempts();
    backoff.cancelAll();
    releaseResumeWaiters();
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
    if (combined.signal.aborted) {
      combined.cleanup();
      throw createAbortError();
    }
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

  const waitBackoff = async (attempt: number, signal: AbortSignal): Promise<"retry" | "resumed" | "stopped"> => {
    const delay = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)] ?? 8000;
    const backoffController = new AbortController();
    const backoffLink = combineSignals(signal, backoffController.signal);
    attemptControllers.add(backoffController);
    const generationBeforeBackoff = resumeGeneration;
    let waited = false;
    try {
      waited = await backoff.wait(delay, backoffLink.signal);
    } finally {
      attemptControllers.delete(backoffController);
      backoffLink.cleanup();
    }
    if (signal.aborted || closed || unauthorized) return "stopped";
    if (suspended || resumeGeneration !== generationBeforeBackoff) return "resumed";
    return waited ? "retry" : "stopped";
  };

  const runReconnectableSse = async (
    signal: AbortSignal,
    url: string,
    getLastEventId: () => string | undefined,
    onEvent: (msg: SseMessage) => void,
  ): Promise<void> => {
    let attempt = 0;
    if (!suspended && connectedStreams === 0 && !unauthorized) {
      reportState("connecting");
    }

    while (!signal.aborted && !closed && !unauthorized) {
      if (suspended) {
        const resumed = await waitWhileSuspended(signal);
        if (!resumed || signal.aborted || closed || unauthorized) return;
        attempt = 0;
        if (connectedStreams === 0 && connectionState === undefined) {
          reportState("connecting");
        }
      }

      const attemptController = new AbortController();
      const attemptLink = combineSignals(signal, attemptController.signal);
      attemptControllers.add(attemptController);
      const generationAtStart = resumeGeneration;

      let wasConnected = false;
      try {
        const lastId = getLastEventId();
        const res = await fetchImpl(url, {
          method: "GET",
          headers: authHeaders({
            accept: "text/event-stream",
            ...(lastId ? { "last-event-id": lastId } : {}),
          }),
          signal: attemptLink.signal,
        });

        if (res.status === 401 || res.status === 403) {
          await res.body?.cancel().catch(() => undefined);
          markUnauthorized();
          return;
        }
        if (res.ok && res.body) {
          attempt = 0;
          wasConnected = true;
          connectedStreams++;
          reportState("connected");
          await readSseStream(res.body, attemptLink.signal, (msg) => {
            if (!attemptLink.signal.aborted && !signal.aborted && !closed) onEvent(msg);
          });
        } else {
          await res.body?.cancel().catch(() => undefined);
        }
      } catch {
        // Network drops and aborts fall through to the lifecycle/reconnect check below.
      } finally {
        attemptControllers.delete(attemptController);
        attemptLink.cleanup();
        if (wasConnected) {
          connectedStreams = Math.max(0, connectedStreams - 1);
        }
      }

      if (signal.aborted || closed || unauthorized) return;
      if (suspended || resumeGeneration !== generationAtStart) {
        // Suspended cleanly or explicitly woken for instant resync: skip disconnect error and backoff.
        attempt = 0;
        continue;
      }

      reportState("reconnecting");
      const nextStep = await waitBackoff(attempt, signal);
      if (nextStep === "stopped") return;
      if (nextStep === "resumed") attempt = 0;
      else attempt++;
    }
  };

  const DECODE_WARN_THROTTLE_MS = 5_000;
  const lastWarnAt = new Map<string, number>();

  const warnThrottled = (key: string, message: string, detail?: unknown) => {
    const now = Date.now();
    const prev = lastWarnAt.get(key) ?? 0;
    if (now - prev >= DECODE_WARN_THROTTLE_MS) {
      lastWarnAt.set(key, now);
      if (detail !== undefined) console.warn(message, detail);
      else console.warn(message);
    }
  };

  const reportDecodeError = (stream: RemoteDecodeError["stream"], topic: string, reason: string, raw: string) => {
    const info: RemoteDecodeError = { stream, topic, reason, raw: raw.slice(0, 200) };
    options.onDecodeError?.(info);
    warnThrottled(`decode:${stream}:${topic}`, `[remote/${stream}] dropped malformed frame (${topic}): ${reason}`);
  };

  const slice: HttpRemoteTransport["slice"] = (kind, listener) => {
    const decoder = sliceDecoders[kind];
    let lastEventId: string | undefined;
    return trackStream(async (signal) => {
      await runReconnectableSse(
        signal,
        `${base}/api/v1/slice/${encodeURIComponent(kind)}`,
        () => lastEventId,
        (msg) => {
          if (msg.id) lastEventId = msg.id;
          const parsed = parseJsonSafe(msg.data);
          const decoded = decoder.safeParse(parsed);
          if (!decoded.success) {
            const reason = parsed === undefined ? "invalid JSON" : decoded.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
            reportDecodeError("slice", kind, reason, msg.data);
            return;
          }
          if (!msg.id) lastEventId = String(decoded.data.seq);
          listener(decoded.data);
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
          if (msg.event === "lagged") {
            warnThrottled("live:lagged", "[remote/live] server broadcast lagged", parseJsonSafe(msg.data));
            return;
          }
          const parsed = parseJsonSafe(msg.data);
          const decoded = LiveEvent.safeParse(parsed);
          if (!decoded.success) {
            const reason = parsed === undefined ? "invalid JSON" : decoded.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; ");
            reportDecodeError("live", "live", reason, msg.data);
            return;
          }
          listener(decoded.data);
        },
      );
    });

  const subscribe: HttpRemoteTransport["subscribe"] = (name, payload, on, ended) => {
    let finished = false;
    let lastEventId: string | undefined;
    return trackStream(async (signal) => {
      let attempt = 0;
      const finish = (why: RemoteEnvelope | null) => {
        if (finished || signal.aborted || closed) return;
        finished = true;
        ended(why);
      };

      while (!finished && !signal.aborted && !closed && !unauthorized) {
        if (suspended) {
          const resumed = await waitWhileSuspended(signal);
          if (!resumed || signal.aborted || closed || unauthorized) return;
          attempt = 0;
        }

        const attemptController = new AbortController();
        const attemptLink = combineSignals(signal, attemptController.signal);
        attemptControllers.add(attemptController);
        const generationAtStart = resumeGeneration;

        try {
          const query = encodeURIComponent(JSON.stringify(payload ?? {}));
          const res = await fetchImpl(`${base}/api/v1/subscribe/${encodeURIComponent(name)}?payload=${query}`, {
            method: "GET",
            headers: authHeaders({
              accept: "text/event-stream",
              ...(lastEventId ? { "last-event-id": lastEventId } : {}),
            }),
            signal: attemptLink.signal,
          });
          if (res.status === 401) {
            await res.body?.cancel().catch(() => undefined);
            markUnauthorized();
            finish({
              bizCode: BizCode.Unauthorized,
              message: "Unauthorized",
            });
            return;
          }
          const contentType = res.headers.get("content-type") ?? "";
          if (!res.ok && res.status >= 500 && !contentType.includes("application/json")) {
            await res.body?.cancel().catch(() => undefined);
          } else if (!res.ok || contentType.includes("application/json")) {
            const text = await res.text();
            const parsed = parseJsonSafe(text);
            const env = toEnvelope(parsed) ?? {
              bizCode: fallbackBizCode(res.status),
              message: text.trim() || `HTTP ${res.status}`,
            };
            finish(env);
            return;
          } else if (!res.body) {
            finish(null);
            return;
          } else {
            attempt = 0;
            await readSseStream(res.body, attemptLink.signal, (msg) => {
              if (attemptLink.signal.aborted || signal.aborted || closed) return;
              if (msg.id) lastEventId = msg.id;
              const parsed = parseJsonSafe(msg.data);
              if (parsed !== undefined) {
                on(parsed);
              } else if (msg.data.trim() !== "") {
                reportDecodeError("subscribe", name, "invalid JSON", msg.data);
              }
            });
            if (signal.aborted || closed) return;
            if (!suspended && resumeGeneration === generationAtStart) {
              finish(null);
              return;
            }
            attempt = 0;
            continue;
          }
        } catch {
          if (signal.aborted || closed) return;
          if (suspended || resumeGeneration !== generationAtStart) {
            attempt = 0;
            continue;
          }
        } finally {
          attemptControllers.delete(attemptController);
          attemptLink.cleanup();
        }

        if (signal.aborted || closed || unauthorized) return;
        if (suspended || resumeGeneration !== generationAtStart) {
          attempt = 0;
          continue;
        }

        const nextStep = await waitBackoff(attempt, signal);
        if (nextStep === "stopped") return;
        if (nextStep === "resumed") attempt = 0;
        else attempt++;
      }
    });
  };

  const suspend = () => {
    if (closed || unauthorized || suspended) return;
    suspended = true;
    abortActiveAttempts();
    backoff.cancelAll();
  };

  const resume = () => {
    if (closed || unauthorized) return;
    suspended = false;
    resumeGeneration++;
    // Abort any stale socket or pending backoff delay, then wake suspended streams for immediate resync.
    abortActiveAttempts();
    backoff.cancelAll();
    releaseResumeWaiters();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    suspended = false;
    if (!master.signal.aborted) master.abort();
    abortActiveAttempts();
    backoff.cancelAll();
    releaseResumeWaiters();
    for (const controller of controllers) {
      if (!controller.signal.aborted) controller.abort();
    }
    controllers.clear();
    if (!unauthorized) {
      reportState("offline");
    }
  };

  return { call, slice, live, subscribe, suspend, resume, close };
}
