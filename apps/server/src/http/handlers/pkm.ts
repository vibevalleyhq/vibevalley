// The answers of the pkm endpoints (packages/protocol/src/pkm/api.ts): each forwards to the service that owns the rule.

import { Effect } from "effect";

import { ownerId } from "@vibevalley/protocol";
import type { PkmHandlers } from "@vibevalley/protocol/api";

import { Pkm } from "@/pkm/pkm.ts";

export const pkmHandlers = Effect.gen(function* () {
  const pkm = yield* Pkm;
  const done: PkmHandlers = {
    "pkm.page.list": () => pkm.list(),
    "pkm.page.get": ({ page }) => pkm.page(page),
    "pkm.page.save": (req) => pkm.save(req),
    "pkm.page.move": (req) => pkm.move(req),
    "pkm.page.rename": (req) => pkm.rename(req),
    "pkm.page.export": ({ page }) => Effect.map(pkm.markdown(page), (markdown) => ({ markdown })),
    "pkm.block.apply": (req) => pkm.apply(req),
    "pkm.search": (req) => pkm.search(req),
    "pkm.capture": ({ text }) => pkm.capture(text),
    "pkm.radar.get": ({ staleDays }) => pkm.radar(staleDays),
    "pkm.comment.list": ({ page }) => pkm.comments(page),
    "pkm.comment.suggest": (req) => pkm.suggest(req, ownerId),
    "pkm.comment.resolve": (req) => pkm.resolve(req),
    "pkm.clip.create": (req) => pkm.clip(req),
    "pkm.cluster.create": (req) => pkm.cluster(req),
    "pkm.undo": () => pkm.undo(),
    "pkm.scan": () => pkm.scan(),
  };
  return done;
});
