import type { RawData, WebSocket } from "ws";

import { type Clock, systemClock } from "@vibevalley/async";

import type { RealtimeEvents, RealtimeLink } from "#/platform/provider/vendors.ts";

/** The upstream line of a bound account: opening it, and taking the key out of what comes back. */
export interface MossLine {
  readonly connect: (on: RealtimeEvents) => RealtimeLink;
  readonly redact: (text: string) => string;
}

export interface MossRelayHooks {
  /** Invoked when the upstream MOSS WebSocket opens; may return a cleanup function invoked when the relay ends. */
  readonly onOpen?: (link: RealtimeLink, sendToPage: (frame: string) => void) => (() => void) | void;
  /** Invoked for each text frame from the browser page; returns the frame to forward to MOSS (or undefined to drop). */
  readonly onPageText?: (data: string, link: RealtimeLink, sendToPage: (frame: string) => void) => string | undefined;
  /** Invoked for each text frame from MOSS Live before it is forwarded to the browser page. */
  readonly onMossText?: (data: string, link: RealtimeLink, sendToPage: (frame: string) => void) => void;
}

/** The page's socket closed with this, after what was queued before it. */
interface CloseFrame {
  readonly code: number;
  readonly reason: string;
}
type Down = string | Uint8Array | CloseFrame;

const isClose = (frame: Down): frame is CloseFrame => typeof frame === "object" && !(frame instanceof Uint8Array);
const size = (frame: Down) => (typeof frame === "string" ? Buffer.byteLength(frame) : isClose(frame) ? 0 : frame.byteLength);
const bytesOf = (data: RawData): Uint8Array => (Array.isArray(data) ? Buffer.concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : data);

/** At most this many frames wait to go down to the page. */
const downFrames = 64;

/** The page and MOSS Live, each way, until either side ends or a limit is passed (the page is then told 1009). */
export function relay(page: WebSocket, line: MossLine, hooks?: MossRelayHooks, clock: Pick<Clock, "now"> = systemClock): Promise<void> {
  const { promise: ended, resolve: end } = Promise.withResolvers<void>();
  const down: Down[] = [];
  let pumping = false;
  let downBytes = 0;
  let waitingBytes = 0;
  let windowBytes = 0;
  let windowAt = clock.now();
  // connecting → open (MOSS took the link) → closing (a limit was passed: the page is being told) → finished.
  let phase: "connecting" | "open" | "closing" | "finished" = "connecting";
  /** Nothing more is taken from either side. */
  const stopped = () => phase === "closing" || phase === "finished";
  let closeHook: (() => void) | void;
  const waiting: (string | Uint8Array)[] = [];

  const finish = () => {
    if (phase === "finished") return;
    phase = "finished";
    waiting.length = 0;
    page.off("message", fromPage);
    page.off("close", finish);
    page.off("error", finish);
    closeHook?.();
    link.close();
    if (page.readyState === page.OPEN || page.readyState === page.CONNECTING) page.close(1011, "Realtime connection closed");
    end();
  };
  const fail = () => {
    if (stopped()) return;
    phase = "closing";
    if (page.readyState === page.OPEN) page.close(1009, "Realtime buffer limit");
    finish();
  };
  // One frame at a time to the page, each written before the next: a slow page backs the queue up to its limit.
  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      for (let frame = down.shift(); frame !== undefined && phase !== "finished"; frame = down.shift()) {
        downBytes -= size(frame);
        if (isClose(frame)) {
          if (page.readyState === page.OPEN) page.close(frame.code, frame.reason);
          finish();
          return;
        }
        const sending = frame;
        await new Promise<void>((resolve, reject) => page.send(sending, (e) => (e ? reject(e) : resolve())));
      }
    } catch {
      // The page's socket would not take a frame: it is gone, and the relay with it.
      finish();
    } finally {
      pumping = false;
    }
  };
  const enqueue = (frame: Down) => {
    if (stopped()) return;
    const bytes = size(frame);
    if (bytes > 512 * 1024 || downBytes + bytes > 2 * 1024 * 1024 || down.length >= downFrames) return fail();
    downBytes += bytes;
    down.push(frame);
    void pump();
  };
  const sendToPage = (frame: string) => enqueue(frame);

  const link: RealtimeLink = line.connect({
    open: () => {
      if (stopped()) return;
      phase = "open";
      closeHook = hooks?.onOpen?.(link, sendToPage);
      for (const frame of waiting.splice(0)) link.send(frame);
      waitingBytes = 0;
    },
    text: (data) => {
      if (stopped()) return;
      if (Buffer.byteLength(data) > 256 * 1024) return fail();
      const safe = line.redact(data);
      hooks?.onMossText?.(safe, link, sendToPage);
      enqueue(safe);
    },
    binary: enqueue,
    // Vendor close reasons may contain credentials or private request content.
    down: () => enqueue({ code: 1011, reason: "Realtime connection closed" }),
  });

  function fromPage(data: RawData, isBinary: boolean) {
    if (stopped()) return;
    const frame: string | Uint8Array = isBinary ? bytesOf(data) : Buffer.from(bytesOf(data)).toString("utf8");
    const bytes = size(frame);
    const now = clock.now();
    if (now - windowAt >= 1000) {
      windowAt = now;
      windowBytes = 0;
    }
    windowBytes += bytes;
    if (bytes > 256 * 1024 + 1 || windowBytes > 1024 * 1024 || (link.bufferedAmount?.() ?? 0) > 512 * 1024) return fail();
    const transformed = typeof frame === "string" && hooks?.onPageText ? hooks.onPageText(frame, link, sendToPage) : frame;
    if (transformed === undefined || stopped()) return;
    if (phase === "open") link.send(transformed);
    else {
      waitingBytes += size(transformed);
      if (waiting.length >= 16 || waitingBytes > 512 * 1024) return fail();
      waiting.push(transformed);
    }
  }
  page.on("message", fromPage);
  page.on("close", finish);
  page.on("error", finish);
  if (page.readyState === page.CLOSING || page.readyState === page.CLOSED) finish();
  return ended;
}
