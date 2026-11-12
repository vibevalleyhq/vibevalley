import type { AgentHandlers } from "@vibevalley/protocol/api";

import type { Agent } from "#/modules/agent/agent.ts";
import type { Runtime } from "#/modules/runtime/runtime.ts";

export function agentHandlers(deps: { readonly agent: Agent; readonly runtime: Runtime }): AgentHandlers {
  const { agent: agents, runtime: runtimes } = deps;
  return {
    "agent.list": async () => agents.all(),
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
    "skill.list": async () => agents.skills(),
    "skill.create": (body) => agents.createSkill(body),
    "skill.update": (skill) => agents.saveSkill(skill),
    "skill.delete": ({ id }) => agents.removeSkill(id),
    "skill.previewDelete": ({ id }) => agents.previewRemoveSkill(id),
    "agent.validate": async (body) => {
      const out = [];
      for (const agent of body.agents) out.push({ id: agent.id, problems: await runtimes.problemsOf(agent) });
      return out;
    },
  };
}
