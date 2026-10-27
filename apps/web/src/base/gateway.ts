// The page's one WebSocket to the farm (rpcPath): the Subscriptions RPCs (packages/protocol/src/rpc.ts), whose answers it
// decodes by their Schema. Effect stays in this file; the rest of the page reads features/channel/follow.ts.

import type { ChannelEvent } from "@vibevalley/protocol";
import { Subscriptions, rpcPath } from "@vibevalley/protocol/rpc";
import { Context, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { RpcClient, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

const makeClient = RpcClient.make(Subscriptions);

class SubscriptionsClient extends Context.Service<SubscriptionsClient, Effect.Success<typeof makeClient>>()("vibevalley/web/SubscriptionsClient") {}

// The client lives as long as the runtime: built in its layer, the socket stays open between subscriptions, and the
// protocol reopens it (with backoff) when it drops.
const client = Layer.effect(SubscriptionsClient, makeClient).pipe(
  Layer.provide(RpcClient.layerProtocolSocket({ retryTransientErrors: true })),
  Layer.provide(Socket.layerWebSocket(Effect.sync(() => `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${rpcPath}`))),
  Layer.provide(Socket.layerWebSocketConstructorGlobal),
  Layer.provide(RpcSerialization.layerJson),
);

let runtime: ManagedRuntime.ManagedRuntime<SubscriptionsClient, never> | undefined;

/** Each event of one subscription until stop() is called, or until it ends (the farm ended it, or the line broke): then
 * ended(), and the caller follows again from what it has. */
function run(
  stream: (c: SubscriptionsClient["Service"]) => Stream.Stream<ChannelEvent, unknown>,
  on: (e: ChannelEvent) => void,
  ended: () => void,
): () => void {
  runtime ??= ManagedRuntime.make(client);
  let stopped = false;
  const fiber = runtime.runFork(
    Effect.gen(function* () {
      yield* Stream.runForEach(stream(yield* SubscriptionsClient), (e) => Effect.sync(() => on(e)));
    }).pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => void (stopped || ended())))),
  );
  return () => {
    stopped = true;
    fiber.interruptUnsafe();
  };
}

/** What is said in a channel after the message numbered after, then from now on. */
export const followChannel = (id: string, after: number, on: (e: ChannelEvent) => void, ended: () => void) =>
  run((c) => c["channel.follow"]({ id, after }), on, ended);

/** The farm's reports after the one with this id (the newest when absent), then each from now on. */
export const followReports = (after: string | undefined, on: (e: ChannelEvent) => void, ended: () => void) =>
  run((c) => c["channel.reports"](after === undefined ? {} : { after }), on, ended);
