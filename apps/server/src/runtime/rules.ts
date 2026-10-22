// What a runtime's state says about dispatching to it: whether its money is
// gone, what is left of its quota, and what stops a profile on it. agentIssues mirrors the checks oar makes when a session
// opens, so a profile that would be refused is shown so before it is sent.

import type { AccountUsage, Agent, AgentIssue, AgentIssueLevel, ModelEntry, RuntimeInfo, RuntimeQuota } from "@vibevalley/protocol";
import { factsOf, runtimeLabel } from "../agent/seed.ts";
import { yuan } from "./money.ts";

const two = (n: number) => String(n).padStart(2, "0");

function whenText(at: number): string {
  const d = new Date(at);
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日 ${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** Why a runtime takes no work now because of money (quota gone, balance gone, the day's budget spent); "" when it does. */
export function moneyStop(info: RuntimeInfo | null | undefined): string {
  if (!info) return "";
  const u = info.usage;
  if (u?.status === "ok") {
    for (const w of u.windows) {
      if (w.usedPercent < 100) continue;
      const resets = w.resetsAt ? "，" + whenText(w.resetsAt) + "重置" : "";
      return runtimeLabel(info.id) + " 的额度用完了（" + w.label + "）" + resets + "，到时候再派";
    }
  } else if (u?.status === "balance" && u.balances.length > 0) {
    if (!u.available || u.balances.every((b) => !(b.amount > 0))) return u.provider + " 的余额用完了，充值以后再派";
  }
  const budget = info.settings.dailyBudget ?? 0;
  const spent = info.spentToday ?? 0;
  if (budget > 0 && spent >= budget) return "今天已经花了 " + yuan(spent) + "，到了每日预算 " + yuan(budget) + "（在 Runtime 页面可以改）";
  return "";
}

/** The least left of any window, 0 at the least; undefined when the usage has no windows. */
export function quotaLeft(usage: AccountUsage | null | undefined): number | undefined {
  if (usage?.status !== "ok" || usage.windows.length === 0) return undefined;
  return Math.max(0, Math.min(...usage.windows.map((w) => 100 - w.usedPercent)));
}

const balanceText = (currency: string, amount: number) => (currency === "CNY" ? "¥" : currency === "USD" ? "$" : currency + " ") + amount.toFixed(2);

export function quotaText(usage: AccountUsage | null | undefined): string {
  if (!usage) return "不报额度";
  switch (usage.status) {
    case "login_required":
      return "没登录";
    case "unavailable":
      return "读不到额度（" + usage.reason + "）";
    case "balance":
      if (usage.balances.length === 0) return usage.provider + " 读不到余额";
      return usage.provider + " 余额 " + usage.balances.map((b) => balanceText(b.currency, b.amount)).join("、") + (usage.available ? "" : "，不够用了");
    case "ok":
      if (usage.windows.length === 0) return usage.subscription ?? "有额度";
      return usage.windows.map((w) => w.label + " 剩 " + String(100 - w.usedPercent) + "%").join("，");
  }
}

/** What RuntimeInfo.quota says: the lowest window left, and in words. */
export function quotaOf(usage: AccountUsage | null | undefined): RuntimeQuota {
  const left = quotaLeft(usage);
  return { ...(left !== undefined ? { left } : {}), text: quotaText(usage) };
}

const blank = (s: string | undefined) => (s ?? "").trim() === "";

/** The profile's issues against its runtime as it is now; errors stop it being sent. */
export function agentIssues(agent: Agent, runtime: RuntimeInfo | null | undefined): AgentIssue[] {
  const issues: AgentIssue[] = [];
  const add = (field: string, level: AgentIssueLevel, text: string) => issues.push({ field, level, text });
  // The probed facts; seeds.json's for a runtime not probed.
  const facts = runtime?.facts?.refused ? runtime.facts : factsOf(agent.runtime);
  const refused = facts.refused ?? {};
  if (!runtime) add("runtime", "error", "不认识的 runtime：" + agent.runtime);
  else if (runtime.installation.status !== "available") add("runtime", "error", "这台机器上找不到这个 runtime");
  else if (!runtime.settings.enabled) add("runtime", "error", "这个 runtime 在 Runtime 页面里被停用了");
  const broke = moneyStop(runtime);
  if (broke) add("runtime", "error", broke);

  const promptOption = agent.personaMode === "append" ? "appendSystemPrompt" : agent.personaMode === "replace" ? "systemPrompt" : "";
  if (!blank(agent.persona) && promptOption && refused[promptOption]) add("persona", "error", refused[promptOption] + "。把人设改成「写进工单开头」。");
  if (agent.effort && refused.effort) add("effort", "error", refused.effort);
  if (Object.keys(agent.env ?? {}).length > 0 && refused.env) add("env", "error", refused.env);
  if ((agent.mcpServers ?? []).length > 0 && refused.mcpServers) add("mcpServers", "error", refused.mcpServers);
  if ((agent.disallowedTools ?? []).length > 0 && refused.disallowedTools) add("disallowedTools", "error", refused.disallowedTools);
  const models = runtime?.models;
  if (runtime && models && agent.model) {
    const model = models.find((m) => m.id === agent.model);
    if (!model) add("model", "warn", runtime.id + " 的模型列表里没有 " + agent.model);
    else if (agent.effort && model.effortLevels.length > 0 && !model.effortLevels.includes(agent.effort))
      add("effort", "error", model.name + " 没有 " + agent.effort + " 这一档，可选：" + model.effortLevels.join("、"));
  } else if (runtime && models && agent.effort) {
    // No model named: the runtime's default one (its settings', else the one it says it uses) must take the effort.
    const wanted = runtime.settings.defaultModel;
    const model: ModelEntry | undefined = models.find((m) => (wanted ? m.id === wanted : m.isDefault));
    if (model && model.effortLevels.length > 0 && !model.effortLevels.includes(agent.effort))
      add("effort", "error", runtime.id + " 默认用的 " + model.name + " 没有 " + agent.effort + " 这一档，可选：" + model.effortLevels.join("、"));
  }
  return issues;
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
    const score = (c.agent.tags ?? []).filter((t) => text.includes(t.toLowerCase())).length;
    if (score > bestScore) {
      best = c.agent;
      bestScore = score;
    }
  }
  return best;
}
