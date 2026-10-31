// The page's one WebSocket: the Subscriptions RPCs (packages/protocol/src/rpc.ts) at rpcPath, for the farm's own page.

import { Effect, Layer } from "effect";
import { type Headers, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import { rpcPath, Subscriptions } from "@vibevalley/protocol/rpc";

import { Channel } from "@/channel/chat.ts";
import { deviceHeader } from "@/lan/lan.ts";

const loopback = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/u;

/** A WebSocket is not held back by CORS: any page the owner opens could connect, so only the farm's own page may. The
 * host must be a loopback name too, or a page whose name is made to resolve here (DNS rebinding) would be its own origin.
 * What the lan listener hands on (the device header) it has checked itself. */
export const fromTheFarm = (headers: Headers.Headers): boolean => {
  if (headers[deviceHeader]) return true;
  const host = headers.host ?? "";
  if (!loopback.test(host)) return false;
  return headers.origin === undefined || headers.origin === `http://${host}`;
};

const handlers = Subscriptions.toLayer(
  Effect.gen(function* () {
    const chat = yield* Channel;
    return Subscriptions.of({
      "channel.follow": ({ id, after }) => chat.follow(id, after),
      "channel.reports": ({ after }) => chat.reports(after),
    });
  }),
);

export const subscriptions = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const upgrade = yield* RpcServer.toHttpEffectWebsocket(Subscriptions);
    yield* router.add(
      "GET",
      rpcPath,
      Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) =>
        fromTheFarm(request.headers) ? upgrade : Effect.succeed(HttpServerResponse.text("not the farm's page", { status: 403 })),
      ),
    );
  }),
).pipe(Layer.provide(handlers), Layer.provide(RpcSerialization.layerJson));
