import type * as T from "@vibevalley/protocol";
import type { MemoryHandlers } from "@vibevalley/protocol/api";

import { user } from "#/base/actor.ts";
import { requestKeys } from "#/gateway/http/api.ts";
import type { Time } from "#/infra/time.ts";
import type { Agent } from "#/modules/agent/agent.ts";
import type { Memory } from "#/modules/memory/memory.ts";

export function memoryHandlers(deps: { readonly agent: Agent; readonly memory: Memory; readonly clock: Time }): MemoryHandlers {
  const { agent: agents, memory } = deps;
  const memoryOnce = requestKeys<T.Memory>(deps.clock);
  return {
    "memory.list": ({ agent }) => memory.memoriesOf(agent),
    "memory.recall": ({ agent, repo, text }) => memory.recallOf(agent, repo ?? "", text ?? ""),
    "memory.search": ({ agent, repo, text }) =>
      memory.search({ agent: agent ? (agents.named(agent)?.id ?? agent) : "", repo: repo ?? "", text: text ?? "", kind: "", limit: 0 }),
    "memory.create": ({ agent, ...body }) => memoryOnce(body.requestKey, () => memory.remember({ agent, text: body.text, repo: body.repo ?? "", by: user })),
    "memory.delete": ({ agent, memory: id }) => memory.forget(agent, id),
    "memory.previewDelete": ({ agent, memory: id }) => memory.previewForget(agent, id),
  };
}
