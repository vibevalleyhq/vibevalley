// The page's one WebSocket to the farm (/api/v1/rooms): the Rooms RPCs (packages/protocol/src/rpc.ts), whose answers it
// decodes by their Schema. Effect stays in this file; the rest of the page reads data/rooms.ts.

import type { RoomEvent } from "@vibevalley/protocol";
import { Rooms, roomsPath } from "@vibevalley/protocol/rpc";
import { Context, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

const makeClient = RpcClient.make(Rooms);

class RoomsClient extends Context.Service<RoomsClient, Effect.Success<typeof makeClient>>()("vibevalley/web/RoomsClient") {}

// The client lives as long as the runtime: built in its layer, the socket stays open between subscriptions, and the
// protocol reopens it (with backoff) when it drops.
const client = Layer.effect(RoomsClient, makeClient).pipe(
  Layer.provide(RpcClient.layerProtocolSocket({ retryTransientErrors: true })),
  Layer.provide(Socket.layerWebSocket(Effect.sync(() => `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${roomsPath}`))),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerJson),
);

let runtime: ManagedRuntime.ManagedRuntime<RoomsClient, never> | undefined;

/** Each event of one subscription until stop() is called, or until it ends (the farm ended it, or the line broke): then
 * ended(), and the caller follows again from what it has. */
function run(stream: (c: RoomsClient["Service"]) => Stream.Stream<RoomEvent, unknown>, on: (e: RoomEvent) => void, ended: () => void): () => void {
  runtime ??= ManagedRuntime.make(client);
  let stopped = false;
  const fiber = runtime.runFork(
    Effect.gen(function* () {
      yield* Stream.runForEach(stream(yield* RoomsClient), (e) => Effect.sync(() => on(e)));
    }).pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => void (stopped || ended())))),
  );
  return () => {
    stopped = true;
    fiber.interruptUnsafe();
  };
}

/** What is said in a conversation after the message numbered after, then from now on. */
export const followRoom = (room: string, after: number, on: (e: RoomEvent) => void, ended: () => void) =>
  run((c) => c["rooms.follow"]({ room, after }), on, ended);

/** The farm's reports after the one with this id (the newest when absent), then each from now on. */
export const followReports = (after: string | undefined, on: (e: RoomEvent) => void, ended: () => void) =>
  run((c) => c["rooms.reports"](after === undefined ? {} : { after }), on, ended);
