import type * as T from "@vibevalley/protocol";

import type { Who } from "#/base/actor.ts";

import { answers } from "./prompts.ts";
import { answered, callerOf, sessionSchemaTool, tool } from "./schemas.ts";
import type { ToolDeps } from "./tool.ts";

/** A page's blocks shown to a model at most: a long journal is read in part, and the search finds the rest. */
const pageBlocksMax = 300;

export function pkmTools(deps: Pick<ToolDeps, "pkm" | "agent">) {
  const { pkm, agent: agents } = deps;
  const table = (asOrchestrator: boolean) => (asOrchestrator ? tool : sessionSchemaTool);

  const pkmSearch = (asOrchestrator: boolean) =>
    table(asOrchestrator)("pkm.search", async (p: { readonly text: string; readonly tier?: T.PkmTier; readonly limit?: number }) => {
      const hits = await pkm.search({ text: p.text, ...(p.tier ? { tier: p.tier } : {}), limit: p.limit ?? 10 });
      return hits.length === 0 ? answers.pkm.none(p.text) : hits.map(answers.pkm.hit).join("\n");
    });

  const pkmPage = (asOrchestrator: boolean) =>
    table(asOrchestrator)("pkm.page.get", (p: { readonly page: string }) =>
      answered(async () => {
        const { page } = await pkm.page(p.page.trim());
        return answers.pkm.page(page, page.blocks.slice(0, pageBlocksMax).map(answers.pkm.block), Math.max(0, page.blocks.length - pageBlocksMax));
      }),
    );

  const pkmCapture = (who: Who, asOrchestrator: boolean) =>
    table(asOrchestrator)("pkm.capture", (p: { readonly text: string }) => {
      const c = callerOf(who);
      const name = agents.agent(c.agent)?.name ?? c.agent;
      return answered(async () => answers.pkm.captured((await pkm.capture(p.text, name)).title));
    });

  const pkmSuggest = (who: Who, asOrchestrator: boolean) =>
    table(asOrchestrator)("pkm.comment.suggest", (p: { readonly block: string; readonly suggested: string; readonly rationale?: string }) => {
      const c = callerOf(who);
      const req = { block: p.block.trim(), suggested: p.suggested, ...(p.rationale ? { rationale: p.rationale } : {}) };
      return answered(async () => {
        const made = await pkm.suggest(req, c.agent);
        return answers.pkm.suggested(made.comment.id, made.restored);
      });
    });

  return {
    orchestrator: (who: Who) => [pkmSearch(true), pkmPage(true), pkmCapture(who, true), pkmSuggest(who, true)],
    session: (who: Who) => [pkmSearch(false), pkmPage(false), pkmCapture(who, false), pkmSuggest(who, false)],
  };
}
