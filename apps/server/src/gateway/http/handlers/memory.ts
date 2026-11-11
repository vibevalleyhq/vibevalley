import { Effect } from "effect";

import type * as T from "@vibevalley/protocol";
import type { MemoryHandlers } from "@vibevalley/protocol/api";

import { user } from "#/base/actor.ts";
import { requestKeys } from "#/gateway/http/api.ts";
import { Agent } from "#/modules/agent/agent.ts";
import { Memory } from "#/modules/memory/memory.ts";

export const memoryHandlers = Effect.gen(function* () {
  const agents = yield* Agent;
  const memory = yield* Memory;
  const memoryOnce = yield* requestKeys<T.Memory>();
  const done: MemoryHandlers = {
    "memory.list": ({ agent }) => memory.memoriesOf(agent),
    "memory.recall": ({ agent, repo, text }) => memory.recallOf(agent, repo ?? "", text ?? ""),
    "memory.search": ({ agent, repo, text }) =>
      memory.search({ agent: agent ? (agents.named(agent)?.id ?? agent) : "", repo: repo ?? "", text: text ?? "", kind: "", limit: 0 }),
    "memory.create": ({ agent, ...body }) => memoryOnce(body.requestKey, memory.remember({ agent, text: body.text, repo: body.repo ?? "", by: user })),
    "memory.delete": ({ agent, memory: id }) => memory.forget(agent, id),
    "memory.previewDelete": ({ agent, memory: id }) => memory.previewForget(agent, id),
  };
  return done;
});
