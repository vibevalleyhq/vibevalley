import { Effect, Queue, type Scope } from "effect";
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

/** Where MOSS's frames go to the page, and where a closing goes: one queue, so they keep their order. */
type Down = string | Uint8Array | Socket.CloseEvent;

/** The page's frames wait in a queue until MOSS opens. */
export const relay = (
  page: Socket.Socket,
  key: string,
  transport: MossTransport = nodeMossTransport,
  hooks?: MossRelayHooks,
): Effect.Effect<void, never, Scope.Scope> =>
  Effect.gen(function* () {
    const down = yield* Queue.unbounded<Down>();
    const writer = yield* page.writer;
    const sendToPage = (frame: string) => {
      Queue.offerUnsafe(down, frame);
    };
    let open = false;
    let closeHook: (() => void) | void;
    const waiting: (string | Uint8Array)[] = [];
    const link: MossLink = yield* Effect.acquireRelease(
      Effect.sync(() =>
        transport.connect(key, {
          open: () => {
            open = true;
            closeHook = hooks?.onOpen?.(link, sendToPage);
            for (const f of waiting.splice(0)) link.send(f);
          },
          text: (data) => {
            hooks?.onMossText?.(data, link, sendToPage);
            Queue.offerUnsafe(down, data);
          },
          binary: (data) => Queue.offerUnsafe(down, data),
          // 1011: MOSS went away; its reason, when it gave one, goes to the page.
          down: (why) => Queue.offerUnsafe(down, new Socket.CloseEvent(1011, why.slice(0, 120))),
        }),
      ),
      (l) =>
        Effect.sync(() => {
          closeHook?.();
          l.close();
        }),
    );
    const toPage = Effect.gen(function* () {
      for (;;) {
        const frame = yield* Queue.take(down);
        yield* writer.write(frame);
        if (Socket.isCloseEvent(frame)) return;
      }
    });
    const fromPage = Effect.gen(function* () {
      const { pull } = yield* page.reader;
      for (;;)
        for (const frame of yield* pull) {
          const transformed = typeof frame === "string" && hooks?.onPageText ? hooks.onPageText(frame, link, sendToPage) : frame;
          if (transformed === undefined) continue;
          if (open) link.send(transformed);
          else waiting.push(transformed);
        }
    });
    yield* Effect.raceFirst(toPage, fromPage).pipe(Effect.ignore({ log: "Debug" }));
  });
