// As oar's checks when a session opens: a profile it would refuse shows so before it is sent.

import { list, t } from "@vibevalley/i18n";
import type { Agent, AgentProblem, AgentProblemLevel, RuntimeInfo, RuntimeSettings } from "@vibevalley/protocol";
import { sessionAppendSystemPrompt, sessionDisallowedTools, sessionEffort, sessionEnv, sessionMcpServers, sessionSystemPrompt } from "@vibevalley/protocol";

import { factsOf } from "./presets.ts";
import { moneyStop } from "./quota.ts";

const blank = (s: string | undefined) => (s ?? "").trim() === "";

/** Both the dispatch check and session opening validate these choices; availability and spending only gate new work. */
export function sessionOptions(agent: Agent, settings: RuntimeSettings | undefined, runtime: RuntimeInfo | undefined) {
  const models = runtime?.models;
  const wanted = agent.model || settings?.defaultModel || "";
  const missingModel = wanted && models && !models.some((m) => m.id === wanted) ? wanted : "";
  const options = {
    model: missingModel ? "" : wanted,
    effort: agent.effort || settings?.defaultEffort || "",
    env: { ...settings?.env, ...agent.env },
    missingModel,
  };
  const problems: AgentProblem[] = [];
  const add = (field: string, level: AgentProblemLevel, text: string) => problems.push({ field, level, text });
  // The probed facts; seeds.json's for a runtime not probed.
  const facts = runtime?.facts.refused ? runtime.facts : factsOf(agent.runtime);
  const refused = facts.refused;
  const promptOption = agent.personaMode === "append" ? sessionAppendSystemPrompt : agent.personaMode === "replace" ? sessionSystemPrompt : "";
  if (!blank(agent.persona) && promptOption && refused[promptOption]) add("persona", "error", t("server.runtime.persona", { refused: refused[promptOption] }));
  if (options.effort && refused[sessionEffort]) add("effort", "error", refused[sessionEffort]);
  if (Object.keys(options.env).length > 0 && refused[sessionEnv]) add("env", "error", refused[sessionEnv]);
  if (agent.mcpServers.length > 0 && refused[sessionMcpServers]) add("mcpServers", "error", refused[sessionMcpServers]);
  if (agent.disallowedTools.length > 0 && refused[sessionDisallowedTools]) add("disallowedTools", "error", refused[sessionDisallowedTools]);
  if (runtime && options.missingModel) add("model", "warn", t("server.runtime.noModel", { runtime: runtime.id, model: options.missingModel }));
  if (runtime && models && options.effort) {
    const model = models.find((m) => (options.model ? m.id === options.model : m.isDefault));
    if (model && model.effortLevels.length > 0 && !model.effortLevels.includes(options.effort)) {
      const name = agent.model && options.model ? model.name : t("server.runtime.runtimeDefault", { runtime: runtime.id, model: model.name });
      add("effort", "error", t("server.runtime.effort", { model: name, effort: options.effort, levels: list(model.effortLevels) }));
    }
  }
  return { ...options, problems };
}

export function agentProblems(agent: Agent, runtime: RuntimeInfo | undefined): AgentProblem[] {
  const problems: AgentProblem[] = [];
  const add = (text: string) => problems.push({ field: "runtime", level: "error", text });
  if (!runtime) add(t("server.runtime.unknownRuntime", { runtime: agent.runtime }));
  else if (runtime.installation.status !== "available") add(t("server.runtime.notInstalled"));
  else if (!runtime.settings.enabled) add(t("server.runtime.disabled"));
  const broke = moneyStop(runtime);
  if (broke) add(broke);
  return [...problems, ...sessionOptions(agent, runtime?.settings, runtime).problems];
}

export interface Candidate {
  readonly agent: Agent;
  readonly usable: boolean;
}

/** The profile named (by id or name, else a usable one on the runtime named), else the one picked, else the usable one whose tags the brief names most. */
export function chooseAgent(candidates: readonly Candidate[], brief: string, named: string, picked: string): Agent | undefined {
  if (named) {
    const byName = candidates.find((c) => c.agent.id === named || c.agent.name === named) ?? candidates.find((c) => c.agent.runtime === named && c.usable);
    if (byName) return byName.agent;
  }
  if (picked) {
    const chosen = candidates.find((c) => c.agent.id === picked);
    if (chosen) return chosen.agent;
  }
  const text = brief.toLowerCase();
  let best: Agent | undefined;
  let bestScore = -1;
  for (const c of candidates) {
    if (!c.usable) continue;
    const score = c.agent.tags.filter((item) => text.includes(item.toLowerCase())).length;
    if (score > bestScore) {
      best = c.agent;
      bestScore = score;
    }
  }
  return best;
}
