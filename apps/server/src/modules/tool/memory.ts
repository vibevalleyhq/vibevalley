import { foundText, type SearchQuery } from "#/modules/memory/memory.ts";

import { answers, memoryWhere, userAgentWord } from "./prompts.ts";
import { answered, callerOf, refuse, sessionSchemaTool, tool, type Caller, type Orchestrator, type SessionInput, type Who } from "./schemas.ts";
import type { ToolDeps } from "./tool.ts";

export function memoryTools(deps: Pick<ToolDeps, "agent" | "memory">) {
  const { agent: agents, memory } = deps;

  // The orchestrator may say a profile's name or id. Throws ToolRefusal.
  const profile = (key: string): string => {
    const k = key.trim();
    if (k === userAgentWord) throw refuse(answers.rememberOwnNote);
    const a = agents.named(k) ?? agents.agent(k) ?? agents.orchestrators().find((o) => o.name === k);
    if (a && agents.isOrchestrator(a.id)) throw refuse(answers.rememberOwnNote);
    if (!a) throw refuse(answers.noProfileNamed(k));
    return a.id;
  };

  const notWorking = answers.notWorking;

  const query = (q: Partial<SearchQuery>): SearchQuery => ({ agent: "", repo: "", text: "", kind: "", limit: 0, ...q });

  // A session's memories are its profile's: "" is every repo, none is the one it works in.
  const sessionScope = (c: Caller, repo: string | undefined) => (repo === undefined ? c.repo : repo.trim());

  const memorySearch = (who: Who, asOrchestrator: boolean) =>
    asOrchestrator
      ? tool("memory.search", (p: Orchestrator<"memory.search">) =>
          answered(async () => {
            const agent = p.agent?.trim() ? profile(p.agent) : "";
            const q = query({ text: p.text ?? "", repo: (p.repo ?? "").trim(), ...(agent ? { agent } : {}) });
            return foundText(await memory.search(q), q);
          }),
        )
      : sessionSchemaTool("memory.search", async (p: SessionInput<"memory.search">) => {
          const c = callerOf(who);
          if (!c.agent) throw refuse(notWorking);
          const q = query({ agent: c.agent, repo: sessionScope(c, p.repo), text: p.text ?? "" });
          return foundText(await memory.search(q), q);
        });

  const memoryCreate = (who: Who, asOrchestrator: boolean) =>
    asOrchestrator
      ? tool("memory.create", (p: Orchestrator<"memory.create">) =>
          answered(async () => {
            const id = profile(p.agent);
            const c = callerOf(who);
            const m = await memory.remember({ agent: id, text: p.text, repo: p.repo ?? "", by: c.actor });
            return answers.memory.rememberedFor(id, memoryWhere(m), m.id);
          }),
        )
      : sessionSchemaTool("memory.create", async (p: SessionInput<"memory.create">) => {
          const c = callerOf(who);
          if (!c.agent) throw refuse(notWorking);
          const m = await memory.remember({ agent: c.agent, text: p.text, repo: sessionScope(c, p.repo), by: c.actor });
          return answers.memory.remembered(memoryWhere(m), m.id);
        });
  return { memorySearch, memoryCreate };
}
