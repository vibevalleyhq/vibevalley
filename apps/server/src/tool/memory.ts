import { Effect } from "effect";

import { Agent } from "#/agent/agent.ts";
import { foundText, Memory, type SearchQuery } from "#/memory/memory.ts";

import { answers, memoryWhere, userAgentWord } from "./prompts.ts";
import {
  answered,
  callerOf,
  refuse,
  sessionSchemaTool,
  tool,
  type Caller,
  type Orchestrator,
  type SessionInput,
  type ToolRefusal,
  type Who,
} from "./schemas.ts";

export const memoryTools = Effect.gen(function* () {
  const agents = yield* Agent;
  const memory = yield* Memory;

  // The orchestrator may say a profile's name or id.
  const profile = (key: string): Effect.Effect<string, ToolRefusal> => {
    const k = key.trim();
    if (k === userAgentWord) return refuse(answers.rememberOwnNote);
    const a = agents.named(k) ?? agents.agent(k) ?? agents.orchestrators().find((o) => o.name === k);
    if (a && agents.isOrchestrator(a.id)) return refuse(answers.rememberOwnNote);
    return a ? Effect.succeed(a.id) : refuse(answers.noProfileNamed(k));
  };

  const notWorking = answers.notWorking;

  const query = (q: Partial<SearchQuery>): SearchQuery => ({ agent: "", repo: "", text: "", kind: "", limit: 0, ...q });

  // A session's memories are its profile's: "" is every repo, none is the one it works in.
  const sessionScope = (c: Caller, repo: string | undefined) => (repo === undefined ? c.repo : repo.trim());

  const memorySearch = (who: Who, asOrchestrator: boolean) =>
    asOrchestrator
      ? tool(
          "memory.search",
          Effect.fn("Tool.memorySearch")(function* (p: Orchestrator<"memory.search">) {
            const agent = p.agent?.trim() ? yield* profile(p.agent) : "";
            const q = query({ text: p.text ?? "", repo: (p.repo ?? "").trim(), ...(agent ? { agent } : {}) });
            const memorys = yield* memory.search(q);
            return foundText(memorys, q);
          }, answered),
        )
      : sessionSchemaTool(
          "memory.search",
          Effect.fn("Tool.memorySearch")(function* (p: SessionInput<"memory.search">) {
            const c = yield* callerOf(who);
            if (!c.agent) return yield* refuse(notWorking);
            const q = query({ agent: c.agent, repo: sessionScope(c, p.repo), text: p.text ?? "" });
            const memorys = yield* memory.search(q);
            return foundText(memorys, q);
          }),
        );

  const memoryCreate = (who: Who, asOrchestrator: boolean) =>
    asOrchestrator
      ? tool(
          "memory.create",
          Effect.fn("Tool.memoryCreate")(function* (p: Orchestrator<"memory.create">) {
            const id = yield* profile(p.agent);
            const c = yield* callerOf(who);
            const m = yield* memory.remember({ agent: id, text: p.text, repo: p.repo ?? "", by: c.actor });
            return answers.memory.rememberedFor(id, memoryWhere(m), m.id);
          }, answered),
        )
      : sessionSchemaTool(
          "memory.create",
          Effect.fn("Tool.memoryCreate")(function* (p: SessionInput<"memory.create">) {
            const c = yield* callerOf(who);
            if (!c.agent) return yield* refuse(notWorking);
            const m = yield* memory.remember({ agent: c.agent, text: p.text, repo: sessionScope(c, p.repo), by: c.actor });
            return answers.memory.remembered(memoryWhere(m), m.id);
          }),
        );
  return { memorySearch, memoryCreate };
});
