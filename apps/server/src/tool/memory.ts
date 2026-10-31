import { Effect } from "effect";

import { Agent } from "@/agent/agent.ts";
import { foundText, Memory, type SearchQuery } from "@/memory/memory.ts";

import {
  type Caller,
  type Who,
  type Orchestrator,
  type SessionInput,
  type ToolRefusal,
  refuse,
  callerOf,
  answered,
  tool,
  sessionSchemaTool,
} from "./definition.ts";
import { answers, memoryWhere, ownerAgentWord } from "./prompts.ts";

export const memoryTools = Effect.gen(function* () {
  const agents = yield* Agent;
  const memory = yield* Memory;

  // The orchestrator may say a profile's name or id.
  const profile = (key: string): Effect.Effect<string, ToolRefusal> => {
    const k = key.trim();
    if (k === ownerAgentWord) return refuse(answers.rememberOwnNote);
    const a = agents.named(k) ?? agents.agent(k) ?? agents.orchestrators().find((o) => o.name === k);
    if (a && agents.isOrchestrator(a.id)) return refuse(answers.rememberOwnNote);
    return a ? Effect.succeed(a.id) : refuse(answers.noProfileNamed(k));
  };

  const notWorking = answers.notWorking;

  const query = (q: Partial<SearchQuery>): SearchQuery => ({ agent: "", project: "", text: "", kind: "", limit: 0, ...q });

  // A session's memories are its profile's: "" is every project, none is the one it works in.
  const sessionScope = (c: Caller, project: string | undefined) => (project === undefined ? c.project : project.trim());

  const memorySearch = (who: Who, forOrchestrator: boolean) =>
    forOrchestrator
      ? tool(
          "memory.search",
          Effect.fn("Tool.memorySearch")(function* (p: Orchestrator<"memory.search">) {
            const agent = (p.agent ?? "").trim() ? yield* profile(p.agent!) : "";
            const q = query({ text: p.text ?? "", project: (p.project ?? "").trim(), ...(agent ? { agent } : {}) });
            return foundText(yield* memory.search(q), q);
          }, answered),
        )
      : sessionSchemaTool(
          "memory.search",
          Effect.fn("Tool.memorySearch")(function* (p: SessionInput<"memory.search">) {
            const c = yield* callerOf(who);
            if (!c.agent) return yield* refuse(notWorking);
            const q = query({ agent: c.agent, project: sessionScope(c, p.project), text: p.text ?? "" });
            return foundText(yield* memory.search(q), q);
          }),
        );

  const memoryCreate = (who: Who, forOrchestrator: boolean) =>
    forOrchestrator
      ? tool(
          "memory.create",
          Effect.fn("Tool.memoryCreate")(function* (p: Orchestrator<"memory.create">) {
            const id = yield* profile(p.agent);
            const c = yield* callerOf(who);
            const m = yield* memory.remember({ agent: id, text: p.text, project: p.project ?? "", by: c.actor });
            return answers.memory.rememberedFor(id, memoryWhere(m), m.id);
          }, answered),
        )
      : sessionSchemaTool(
          "memory.create",
          Effect.fn("Tool.memoryCreate")(function* (p: SessionInput<"memory.create">) {
            const c = yield* callerOf(who);
            if (!c.agent) return yield* refuse(notWorking);
            const m = yield* memory.remember({ agent: c.agent, text: p.text, project: sessionScope(c, p.project), by: c.actor });
            return answers.memory.remembered(memoryWhere(m), m.id);
          }),
        );
  return { memorySearch, memoryCreate };
});
