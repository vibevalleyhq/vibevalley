import { userId } from "@vibevalley/protocol";
import type { PkmHandlers } from "@vibevalley/protocol/api";

import type { Pkm } from "#/modules/pkm/pkm.ts";

export function pkmHandlers(deps: { readonly pkm: Pkm }): PkmHandlers {
  const { pkm } = deps;
  return {
    "pkm.page.list": () => pkm.list(),
    "pkm.page.get": ({ page }) => pkm.page(page),
    "pkm.page.save": (req) => pkm.save(req),
    "pkm.page.move": (req) => pkm.move(req),
    "pkm.page.rename": (req) => pkm.rename(req),
    "pkm.page.export": async ({ page }) => ({ markdown: await pkm.markdown(page) }),
    "pkm.block.apply": (req) => pkm.apply(req),
    "pkm.search": (req) => pkm.search(req),
    "pkm.capture": ({ text, page }) => pkm.capture(text, undefined, page),
    "pkm.source.get": ({ page }) => pkm.source(page),
    "pkm.source.update": (req) => pkm.sourceUpdate(req),
    "pkm.journal.open": ({ day }) => pkm.journal(day),
    "pkm.radar.get": ({ staleDays }) => pkm.radar(staleDays),
    "pkm.comment.list": ({ page }) => pkm.comments(page),
    "pkm.comment.suggest": (req) => pkm.suggest(req, userId),
    "pkm.comment.resolve": (req) => pkm.resolve(req),
    "pkm.clip.create": (req) => pkm.clip(req),
    "pkm.cluster.create": (req) => pkm.cluster(req),
    "pkm.undo": () => pkm.undo(),
    "pkm.scan": () => pkm.scan(),
  };
}
