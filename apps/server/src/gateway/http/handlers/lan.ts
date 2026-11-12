import type { LanHandlers } from "@vibevalley/protocol/api";

import type { Lan } from "#/gateway/lan/lan.ts";

export function lanHandlers(deps: { readonly lan: Lan }): LanHandlers {
  const { lan } = deps;
  return {
    "lan.get": async () => lan.status(),
    "lan.update": (body) => lan.setOpen(body.open),
    "lan.pairing.start": () => lan.startPairing(),
    "lan.pairing.stop": async () => lan.stopPairing(),
    "lan.pairing.previewStop": async () => lan.previewStopPairing(),
    "lan.pairing.answer": (body) => lan.answer(body.allow),
    "lan.pair": (body) => lan.pair(body.code, body.name),
  };
}
