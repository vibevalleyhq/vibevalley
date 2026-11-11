import { Effect } from "effect";

import type { LanHandlers } from "@vibevalley/protocol/api";

import { Lan } from "#/gateway/lan/lan.ts";

export const lanHandlers = Effect.gen(function* () {
  const lan = yield* Lan;
  const done: LanHandlers = {
    "lan.get": () => Effect.sync(lan.status),
    "lan.update": (body) => lan.setOpen(body.open),
    "lan.pairing.start": () => lan.startPairing(),
    "lan.pairing.stop": () => Effect.sync(lan.stopPairing),
    "lan.pairing.previewStop": () => Effect.sync(lan.previewStopPairing),
    "lan.pairing.answer": (body) => lan.answer(body.allow),
    "lan.pair": (body) => lan.pair(body.code, body.name),
  };
  return done;
});
