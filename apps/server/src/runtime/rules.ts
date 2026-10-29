import { list, t } from "@vibevalley/i18n";
// What a runtime's state says about dispatching to it: whether its money is
// gone, what is left of its quota, and what stops a profile on it. agentProblems mirrors the checks oar makes when a session
// opens, so a profile that would be refused is shown so before it is sent.

import type { AccountUsage, Agent, AgentProblem, AgentProblemLevel, RuntimeInfo, RuntimeQuota, RuntimeSettings } from "@vibevalley/protocol";
import { sessionAppendSystemPrompt, sessionDisallowedTools, sessionEffort, sessionEnv, sessionMcpServers, sessionSystemPrompt } from "@vibevalley/protocol";
import { factsOf, runtimeLabel } from "@/agent/seed.ts";
import { yuan } from "./money.ts";

const two = (n: number) => String(n).padStart(2, "0");

function whenText(at: number): string {
  const d = new Date(at);
  return t("server.runtime.date", { month: d.getMonth() + 1, day: d.getDate(), time: `${two(d.getHours())}:${two(d.getMinutes())}` });
}

/** Why a runtime takes no work now because of money (quota gone, balance gone, the day's budget spent); "" when it does. */
export function moneyStop(info: RuntimeInfo | null | undefined): string {
  if (!info) return "";
  const u = info.usage;
  if (u?.status === "ok") {
    for (const w of u.windows) {
      if (w.usedPercent < 100) continue;
      const resets = w.resetsAt ? t("server.runtime.resets", { when: whenText(w.resetsAt) }) : "";
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

/** The least left of any window, 0 at the least; undefined when the usage has no windows. */
export function quotaLeft(usage: AccountUsage | null | undefined): number | undefined {
  if (usage?.status !== "ok" || usage.windows.length === 0) return undefined;
  return Math.max(0, Math.min(...usage.windows.map((w) => 100 - w.usedPercent)));
}

const balanceText = (currency: string, amount: number) => (currency === "CNY" ? "¥" : currency === "USD" ? "$" : currency + " ") + amount.toFixed(2);

export function quotaText(usage: AccountUsage | null | undefined): string {
  if (!usage) return t("server.runtime.quota.none");
  switch (usage.status) {
    case "login_required":
      return t("server.runtime.quota.signedOut");
    case "unavailable":
      return t("server.runtime.quota.unread", { why: usage.reason });
    case "balance":
      if (usage.balances.length === 0) return t("server.runtime.quota.noBalance", { provider: usage.provider });
      return t(usage.available ? "server.runtime.quota.balance" : "server.runtime.quota.balanceLow", {
        provider: usage.provider,
        balances: list(usage.balances.map((b) => balanceText(b.currency, b.amount))),
      });
    case "ok":
      if (usage.windows.length === 0) return usage.subscription ?? t("server.runtime.quota.some");
      return usage.windows
        .map((w) => t("server.runtime.quota.window", { label: w.label, left: 100 - w.usedPercent }))
        .join(t("server.runtime.quota.windowSeparator"));
  }
}

/** What RuntimeInfo.quota says: the lowest window left, and in words. */
export function quotaOf(usage: AccountUsage | null | undefined): RuntimeQuota {
  const left = quotaLeft(usage);
  return { ...(left !== undefined ? { left } : {}), text: quotaText(usage) };
}

const blank = (s: string | undefined) => (s ?? "").trim() === "";

/** Both the dispatch check and session opening validate these choices; availability and spending only gate new work. */
export function sessionOptions(agent: Agent, settings: RuntimeSettings | undefined, runtime: RuntimeInfo | null | undefined) {
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
  const facts = runtime?.facts?.refused ? runtime.facts : factsOf(agent.runtime);
  const refused = facts.refused ?? {};
  const promptOption = agent.personaMode === "append" ? sessionAppendSystemPrompt : agent.personaMode === "replace" ? sessionSystemPrompt : "";
  if (!blank(agent.persona) && promptOption && refused[promptOption]) add("persona", "error", t("server.runtime.persona", { refused: refused[promptOption] }));
  if (options.effort && refused[sessionEffort]) add("effort", "error", refused[sessionEffort]);
  if (Object.keys(options.env).length > 0 && refused[sessionEnv]) add("env", "error", refused[sessionEnv]);
  if ((agent.mcpServers ?? []).length > 0 && refused[sessionMcpServers]) add("mcpServers", "error", refused[sessionMcpServers]);
  if ((agent.disallowedTools ?? []).length > 0 && refused[sessionDisallowedTools]) add("disallowedTools", "error", refused[sessionDisallowedTools]);
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

/** The profile's problems against its runtime as it is now; errors stop it being sent. */
export function agentProblems(agent: Agent, runtime: RuntimeInfo | null | undefined): AgentProblem[] {
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

/** The profile named (by id or name, else a usable one on the runtime named), else the one picked, else the usable one whose tags the job names most. */
export function chooseAgent(candidates: readonly Candidate[], task: string, named: string, picked: string): Agent | undefined {
  if (named) {
    const byName = candidates.find((c) => c.agent.id === named || c.agent.name === named) ?? candidates.find((c) => c.agent.runtime === named && c.usable);
    if (byName) return byName.agent;
  }
  if (picked) {
    const chosen = candidates.find((c) => c.agent.id === picked);
    if (chosen) return chosen.agent;
  }
  const text = task.toLowerCase();
  let best: Agent | undefined;
  let bestScore = -1;
  for (const c of candidates) {
    if (!c.usable) continue;
    const score = (c.agent.tags ?? []).filter((item) => text.includes(item.toLowerCase())).length;
    if (score > bestScore) {
      best = c.agent;
      bestScore = score;
    }
  }
  return best;
}
