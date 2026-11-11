import { Effect } from "effect";

import type * as T from "@vibevalley/protocol";

import { Agent } from "#/modules/agent/agent.ts";
import { Pkm } from "#/modules/pkm/pkm.ts";

import { answers } from "./prompts.ts";
import { answered, callerOf, sessionSchemaTool, tool, type Who } from "./schemas.ts";

/** A page's blocks shown to a model at most: a long journal is read in part, and the search finds the rest. */
const pageBlocksMax = 300;

export const pkmTools = Effect.gen(function* () {
  const pkm = yield* Pkm;
  const agents = yield* Agent;
  const table = (asOrchestrator: boolean) => (asOrchestrator ? tool : sessionSchemaTool);

  const pkmSearch = (asOrchestrator: boolean) =>
    table(asOrchestrator)(
      "pkm.search",
      Effect.fn("Tool.pkmSearch")(function* (p: { readonly text: string; readonly tier?: T.PkmTier; readonly limit?: number }) {
        const hits = yield* pkm.search({ text: p.text, ...(p.tier ? { tier: p.tier } : {}), limit: p.limit ?? 10 });
        return hits.length === 0 ? answers.pkm.none(p.text) : hits.map(answers.pkm.hit).join("\n");
      }),
    );

  const pkmPage = (asOrchestrator: boolean) =>
    table(asOrchestrator)(
      "pkm.page.get",
      Effect.fn("Tool.pkmPage")(function* (p: { readonly page: string }) {
        return yield* answered(
          Effect.map(pkm.page(p.page.trim()), ({ page }) =>
            answers.pkm.page(page, page.blocks.slice(0, pageBlocksMax).map(answers.pkm.block), Math.max(0, page.blocks.length - pageBlocksMax)),
          ),
        );
      }),
    );

  const pkmCapture = (who: Who, asOrchestrator: boolean) =>
    table(asOrchestrator)(
      "pkm.capture",
      Effect.fn("Tool.pkmCapture")(function* (p: { readonly text: string }) {
        const c = yield* callerOf(who);
        const name = agents.agent(c.agent)?.name ?? c.agent;
        return yield* answered(Effect.map(pkm.capture(p.text, name), (page) => answers.pkm.captured(page.title)));
      }),
    );

  const pkmSuggest = (who: Who, asOrchestrator: boolean) =>
    table(asOrchestrator)(
      "pkm.comment.suggest",
      Effect.fn("Tool.pkmSuggest")(function* (p: { readonly block: string; readonly suggested: string; readonly rationale?: string }) {
        const c = yield* callerOf(who);
        const req = { block: p.block.trim(), suggested: p.suggested, ...(p.rationale ? { rationale: p.rationale } : {}) };
        return yield* answered(Effect.map(pkm.suggest(req, c.agent), (made) => answers.pkm.suggested(made.comment.id, made.restored)));
      }),
    );

  return {
    orchestrator: (who: Who) => [pkmSearch(true), pkmPage(true), pkmCapture(who, true), pkmSuggest(who, true)],
    session: (who: Who) => [pkmSearch(false), pkmPage(false), pkmCapture(who, false), pkmSuggest(who, false)],
  };
});
