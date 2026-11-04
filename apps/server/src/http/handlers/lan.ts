// The answers of the lan endpoints (packages/protocol/src/lan/api.ts): each forwards to the service that owns the rule.

import { Effect, Option } from "effect";
import { HttpServerRequest } from "effect/http";

import type { LanHandlers } from "@vibevalley/protocol/api";

import { deviceHeader, Lan } from "#/lan/lan.ts";

export const lanHandlers = Effect.gen(function* () {
  const lan = yield* Lan;
  const done: LanHandlers = {
    "lan.get": () => Effect.sync(lan.status),
    "lan.update": (body) => lan.setOpen(body.open),
    "lan.pairing.start": () => lan.startPairing(),
    "lan.pairing.stop": () => Effect.sync(lan.stopPairing),
    "lan.pairing.previewStop": () => Effect.sync(lan.previewStopPairing),
    "lan.pairing.answer": (body) => lan.answer(body.allow),
    "lan.device.delete": ({ id }) => lan.forget(id),
    "lan.device.previewDelete": ({ id }) => lan.previewForget(id),
    "lan.pair": (body) => lan.pair(body.code, body.name),
    // Only the lan listener says a device, by a header it never takes from the device.
    "lan.me.get": () =>
      Effect.flatMap(Effect.serviceOption(HttpServerRequest.HttpServerRequest), (request) =>
        lan.me(Option.getOrUndefined(Option.map(request, (r) => r.headers[deviceHeader]))),
      ),
  };
  return done;
});
