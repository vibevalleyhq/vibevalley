import { Effect } from "effect";

import type { AgentHandlers } from "@vibevalley/protocol/api";

import { Agent } from "#/modules/agent/agent.ts";
import { Runtime } from "#/modules/runtime/runtime.ts";

export const agentHandlers = Effect.gen(function* () {
  const agents = yield* Agent;
  const runtimes = yield* Runtime;
  const done: AgentHandlers = {
    "agent.list": () => Effect.sync(agents.all),
    "agent.create": (body) => agents.create(body),
    "agent.update": (agent) => agents.save(agent),
    "agent.delete": ({ id }) => agents.remove(id),
    "agent.previewDelete": ({ id }) => agents.previewRemove(id),
    "agent.template.list": () => agents.templates(),
    "agent.template.install": ({ id }) => agents.installTemplate(id),
    "agent.template.update": ({ agent }) => agents.updateFromTemplate(agent),
    "agent.template.add": ({ path }) => agents.addTemplate(path),
    "agent.template.delete": ({ id }) => agents.removeTemplate(id),
    "agent.template.previewDelete": ({ id }) => agents.previewRemoveTemplate(id),
    "skill.list": () => Effect.sync(agents.skills),
    "skill.create": (body) => agents.createSkill(body),
    "skill.update": (skill) => agents.saveSkill(skill),
    "skill.delete": ({ id }) => agents.removeSkill(id),
    "skill.previewDelete": ({ id }) => agents.previewRemoveSkill(id),
    "agent.validate": (body) => Effect.forEach(body.agents, (agent) => Effect.map(runtimes.problemsOf(agent), (problems) => ({ id: agent.id, problems }))),
  };
  return done;
});
