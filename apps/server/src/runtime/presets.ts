import { Schema } from "effect";

import { list, t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { sessionAppendSystemPrompt, sessionDisallowedTools, sessionEffort, sessionEnv, sessionMcpServers, sessionSystemPrompt } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { localizedJson } from "#/base/json.ts";
import { localParts } from "#/infra/time.ts";

import presetsEn from "./presets.en.json";
import presetsZh from "./presets.json";
import { yuan } from "./quota.ts";

const Presets = Schema.Struct({
  defaultSettings: S.RuntimeSettings,
  fallbackPreset: S.RuntimePreset,
  runtimePresets: Schema.Array(S.RuntimePreset),
  runtimeSupport: Schema.Record(Schema.String, S.RuntimeSupport),
  runtimeIds: Schema.Array(Schema.String),
});
const presets = localizedJson(Presets, presetsZh, presetsEn);

export const defaultSettings = (): T.RuntimeSettings => ({ ...presets().defaultSettings, env: {} });

/** Every runtime the farm knows, in the order the page shows them. */
export const runtimeIds = (): string[] => [...presets().runtimeIds];

/** A runtime's name, look and blurb; one the farm has no look for gets the fallback, named by its id. */
export function presetOf(runtime: string): T.RuntimePreset {
  const found = presets().runtimePresets.find((p) => p.id === runtime);
  return structuredClone(found ?? { ...presets().fallbackPreset, id: runtime, label: runtime });
}

export const runtimeLabel = (runtime: string) => presetOf(runtime).label;

/** What the farm knows a runtime takes before probing it: for one it has no word on, nothing beyond a prompt. */
export function supportOf(runtime: string): T.RuntimeSupport {
  const support = presets().runtimeSupport[runtime];
  return support ? structuredClone(support) : { steer: false, refused: {}, capabilities: [], inProcess: false };
}

const two = (n: number) => String(n).padStart(2, "0");

function whenText(at: number): string {
  const d = localParts(at);
  return t("server.runtime.date", { month: d.month, day: d.day, time: `${two(d.hour)}:${two(d.minute)}` });
}

/** Why a runtime takes no work now because of money (quota gone, balance gone, the day's budget spent); "" when it does. */
export function moneyStop(info: T.RuntimeInfo | undefined): string {
  if (!info) return "";
  const u = info.usage;
  if (u?.status === "ok") {
    for (const w of u.windows) {
      if (w.usedPercent < 100) continue;
      const resets = w.resetsAt != null && w.resetsAt !== 0 ? t("server.runtime.resets", { when: whenText(w.resetsAt) }) : "";
      return t("server.runtime.quotaGone", { runtime: runtimeLabel(info.id), window: w.label, resets });
    }
  } else if (u?.status === "balance" && u.balances.length > 0) {
    if (!u.available || u.balances.every((b) => !(b.amount > 0))) return t("server.runtime.balanceGone", { provider: u.provider });
  }
  const budget = info.settings.dailyBudget ?? 0;
  const spent = info.spentToday ?? 0;
  if (budget > 0 && spent >= budget) return t("server.runtime.budget", { spent: yuan(spent), budget: yuan(budget) });
  return "";
}

const blank = (s: string | undefined) => (s ?? "").trim() === "";

/** Both the dispatch check and session opening validate these choices; availability and spending only gate new work. */
export function sessionOptions(agent: T.Agent, settings: T.RuntimeSettings | undefined, runtime: T.RuntimeInfo | undefined) {
  const models = runtime?.models;
  const wanted = agent.model || settings?.defaultModel || "";
  const missingModel = wanted && models && !models.some((m) => m.id === wanted) ? wanted : "";
  const options = {
    model: missingModel ? "" : wanted,
    effort: agent.effort || settings?.defaultEffort || "",
    env: { ...settings?.env, ...agent.env },
    missingModel,
  };
  const problems: T.AgentProblem[] = [];
  const add = (field: string, level: T.AgentProblemLevel, text: string) => problems.push({ field, level, text });
  // What the probe found it supports; seeds.json's for a runtime not probed.
  const support = runtime?.support.refused ? runtime.support : supportOf(agent.runtime);
  const refused = support.refused;
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

export function agentProblems(agent: T.Agent, runtime: T.RuntimeInfo | undefined): T.AgentProblem[] {
  const problems: T.AgentProblem[] = [];
  const add = (text: string) => problems.push({ field: "runtime", level: "error", text });
  if (!runtime) add(t("server.runtime.unknownRuntime", { runtime: agent.runtime }));
  else if (runtime.installation.status !== "available") add(t("server.runtime.notInstalled"));
  else if (!runtime.settings.enabled) add(t("server.runtime.disabled"));
  const broke = moneyStop(runtime);
  if (broke) add(broke);
  return [...problems, ...sessionOptions(agent, runtime?.settings, runtime).problems];
}

export interface Candidate {
  readonly agent: T.Agent;
  readonly usable: boolean;
}

/** The profile named (by id or name, else a usable one on the runtime named), else the one picked, else the usable one whose tags the brief names most. */
export function chooseAgent(candidates: readonly Candidate[], brief: string, named: string, picked: string): T.Agent | undefined {
  if (named) {
    const byName = candidates.find((c) => c.agent.id === named || c.agent.name === named) ?? candidates.find((c) => c.agent.runtime === named && c.usable);
    if (byName) return byName.agent;
  }
  if (picked) {
    const chosen = candidates.find((c) => c.agent.id === picked);
    if (chosen) return chosen.agent;
  }
  const text = brief.toLowerCase();
  let best: T.Agent | undefined;
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
