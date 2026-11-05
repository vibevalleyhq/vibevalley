import { Effect } from "effect";

import type * as T from "@vibevalley/protocol";
import type { MemoryHandlers } from "@vibevalley/protocol/api";

import { Agent } from "#/agent/agent.ts";
import { owner } from "#/base/actor.ts";
import { requestKeys } from "#/http/api.ts";
import { Memory } from "#/memory/memory.ts";

export const memoryHandlers = Effect.gen(function* () {
  const agents = yield* Agent;
  const memory = yield* Memory;
  const memoryOnce = requestKeys<T.Memory>();
  const done: MemoryHandlers = {
    "memory.list": ({ agent }) => memory.memoriesOf(agent),
    "memory.recall": ({ agent, project, text }) => memory.recallOf(agent, project ?? "", text ?? ""),
    "memory.search": ({ agent, project, text }) =>
      memory.search({ agent: agent ? (agents.named(agent)?.id ?? agent) : "", project: project ?? "", text: text ?? "", kind: "", limit: 0 }),
    "memory.create": ({ agent, ...body }) => memoryOnce(body.requestKey, memory.remember({ agent, text: body.text, project: body.project ?? "", by: owner })),
    "memory.delete": ({ agent, memory: id }) => memory.forget(agent, id),
    "memory.previewDelete": ({ agent, memory: id }) => memory.previewForget(agent, id),
  };
  return done;
});
