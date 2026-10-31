// The page's one WebSocket to the farm (rpcPath): the Subscriptions RPCs (packages/protocol/src/rpc.ts), whose answers it
// decodes by their Schema. Effect stays in this file; the rest of the page reads features/channel/follow.ts.

import { Context, Effect, Layer, ManagedRuntime, Stream } from "effect";
import { RpcClient, type RpcClientError, RpcSerialization } from "effect/rpc";
import { Socket } from "effect/socket";

import type { ArtifactEvent, ChannelEvent, SuggestionEvent } from "@vibevalley/protocol";
import type { ApiError } from "@vibevalley/protocol/api";
import { Subscriptions, rpcPath } from "@vibevalley/protocol/rpc";

const makeClient = RpcClient.make(Subscriptions);

// The client lives as long as the runtime: built in its layer, the socket stays open between subscriptions, and the
// protocol reopens it (with backoff) when it drops.
class SubscriptionsClient extends Context.Service<SubscriptionsClient, Effect.Success<typeof makeClient>>()("vibevalley/web/SubscriptionsClient") {
  static readonly layer = Layer.effect(SubscriptionsClient, makeClient).pipe(
    Layer.provide(RpcClient.layerProtocolSocket({ retryTransientErrors: true })),
    Layer.provide(Socket.layerWebSocket(Effect.sync(() => `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}${rpcPath}`))),
    Layer.provide(Socket.layerWebSocketConstructorGlobal),
    Layer.provide(RpcSerialization.layerJson),
  );
}

let runtime: ManagedRuntime.ManagedRuntime<SubscriptionsClient, never> | undefined;

// A dev reload builds this module again: the old runtime closes its socket rather than leaving it open beside the new one.
import.meta.hot?.dispose(() => {
  void runtime?.dispose();
});

/** Each event of one subscription until stop() is called, or until it ends (the farm ended it, or the line broke): then
 * ended(), and the caller follows again from what it has. */
function run<E>(
  stream: (c: SubscriptionsClient["Service"]) => Stream.Stream<E, RpcClientError.RpcClientError | ApiError>,
  on: (e: E) => void,
  ended?: () => void,
): () => void {
  runtime ??= ManagedRuntime.make(SubscriptionsClient.layer);
  let stopped = false;
  const fiber = runtime.runFork(
    Effect.gen(function* () {
      yield* Stream.runForEach(stream(yield* SubscriptionsClient), (e) => Effect.sync(() => on(e)));
    }).pipe(Effect.ignore, Effect.ensuring(Effect.sync(() => void (stopped || ended?.())))),
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

/** A blocks artifact's changes after this seq, then each batch from now on. */
export const followArtifact = (id: string, after: number, on: (e: ArtifactEvent) => void, ended: () => void) =>
  run((c) => c["artifact.follow"]({ id, after }), on, ended);

/** An artifact's suggestions as they now are, then the whole list after each change. */
export const followSuggestions = (id: string, on: (e: SuggestionEvent) => void, ended?: () => void) =>
  run((c) => c["artifact.suggestion.follow"]({ id }), on, ended);
