import { Clock, Deferred, Effect, Queue, type Scope } from "effect";
import { Socket } from "effect/socket";

import { type MossLink, type MossTransport, nodeMossTransport } from "@vibevalley/provider/moss/server";

export interface MossRelayHooks {
  /** Invoked when the upstream MOSS WebSocket opens; may return a cleanup function invoked when the relay ends. */
  readonly onOpen?: (link: MossLink, sendToPage: (frame: string) => void) => (() => void) | void;
  /** Invoked for each text frame from the browser page; returns the frame to forward to MOSS (or undefined to drop). */
  readonly onPageText?: (data: string, link: MossLink, sendToPage: (frame: string) => void) => string | undefined;
  /** Invoked for each text frame from MOSS Live before it is forwarded to the browser page. */
  readonly onMossText?: (data: string, link: MossLink, sendToPage: (frame: string) => void) => void;
}

type Down = string | Uint8Array | Socket.CloseEvent;

export const relay = (
  page: Socket.Socket,
  key: string,
  transport: MossTransport = nodeMossTransport,
  hooks?: MossRelayHooks,
  model = "moss-live-1.0",
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const down = yield* Queue.bounded<Down>(64);
    const overflow = yield* Deferred.make<void>();
    const writer = yield* page.writer;
    let downBytes = 0;
    let waitingBytes = 0;
    let windowBytes = 0;
    let windowAt = yield* Clock.currentTimeMillis;
    let open = false;
    let closed = false;
    let closeHook: (() => void) | void;
    const waiting: (string | Uint8Array)[] = [];
    const size = (frame: Down) => (typeof frame === "string" ? Buffer.byteLength(frame) : Socket.isCloseEvent(frame) ? 0 : frame.byteLength);
    const fail = () => {
      if (closed) return;
      closed = true;
      Deferred.doneUnsafe(overflow, Effect.void);
    };
    const enqueue = (frame: Down) => {
      if (closed) return;
      const bytes = size(frame);
      if (bytes > 512 * 1024 || downBytes + bytes > 2 * 1024 * 1024 || !Queue.offerUnsafe(down, frame)) return fail();
      downBytes += bytes;
    };
    const sendToPage = (frame: string) => enqueue(frame);
    const link: MossLink = yield* Effect.acquireRelease(
      Effect.sync(() =>
        transport.connect(
          key,
          {
            open: () => {
              if (closed) return;
              open = true;
              closeHook = hooks?.onOpen?.(link, sendToPage);
              for (const frame of waiting.splice(0)) link.send(frame);
              waitingBytes = 0;
            },
            text: (data) => {
              if (closed) return;
              if (Buffer.byteLength(data) > 256 * 1024) return fail();
              const safe = key ? data.replaceAll(key, "[redacted]") : data;
              hooks?.onMossText?.(safe, link, sendToPage);
              enqueue(safe);
            },
            binary: enqueue,
            // Vendor close reasons may contain credentials or private request content.
            down: () => enqueue(new Socket.CloseEvent(1011, "Realtime connection closed")),
          },
          model,
        ),
      ),
      (connection) =>
        Effect.sync(() => {
          closed = true;
          waiting.length = 0;
          closeHook?.();
          connection.close();
        }),
    );
    const toPage = Effect.gen(function* () {
      for (;;) {
        const frame = yield* Queue.take(down);
        downBytes -= size(frame);
        yield* writer.write(frame);
        if (Socket.isCloseEvent(frame)) return;
      }
    });
    const fromPage = Effect.gen(function* () {
      const { pull } = yield* page.reader;
      for (;;)
        for (const frame of yield* pull) {
          const bytes = size(frame);
          const now = yield* Clock.currentTimeMillis;
          if (now - windowAt >= 1000) {
            windowAt = now;
            windowBytes = 0;
          }
          windowBytes += bytes;
          if (bytes > 256 * 1024 + 1 || windowBytes > 1024 * 1024 || (link.bufferedAmount?.() ?? 0) > 512 * 1024) {
            fail();
            return yield* Effect.never;
          }
          const transformed = typeof frame === "string" && hooks?.onPageText ? hooks.onPageText(frame, link, sendToPage) : frame;
          if (transformed === undefined || closed) continue;
          if (open) link.send(transformed);
          else {
            waitingBytes += size(transformed);
            if (waiting.length >= 16 || waitingBytes > 512 * 1024) {
              fail();
              return yield* Effect.never;
            }
            waiting.push(transformed);
          }
        }
    });
    const failed = Deferred.await(overflow).pipe(Effect.andThen(writer.write(new Socket.CloseEvent(1009, "Realtime buffer limit"))));
    yield* Effect.raceFirst(Effect.raceFirst(toPage, fromPage), failed).pipe(Effect.ignore({ log: "Debug" }));
  });
