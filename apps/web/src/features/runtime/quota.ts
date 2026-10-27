// A runtime's account, as the runtimes page and the farm's bottle both say it: how much is left, its windows in
// words, when it resets, and the machine each runtime is drawn as.

import { rulesWording } from "../../base/words/rules";
import type { RuntimeInfo } from "@vibevalley/protocol";
import { numberText } from "../../base/format";

/** A switched-off runtime's account is not the farm's business. */
export const usableRuntimes = (all: readonly RuntimeInfo[]) => all.filter((r) => r.installation.status === "available" && r.settings.enabled);

export type QuotaLevel = "plenty" | "low" | "gold" | "empty" | "unknown";

/** Below this much left (percent) the farm warns and the orchestrator sends someone else if it can (protocol.QuotaLow). */
export const quotaLow = 15;

/** How full a quota's bottle is drawn, by the share left. */
export const quotaLevel = (left: number | undefined): QuotaLevel => (left === undefined ? "unknown" : left < quotaLow ? "empty" : left < 50 ? "low" : "plenty");

/** Runtimes name their windows in English; the common ones are said in the page's words. */
export function windowLabel(label: string) {
  if (label === "Current session") return rulesWording().quota.session;
  if (label === "Weekly included usage") return rulesWording().quota.weekly;
  const week = /^Current week \((.+)\)$/.exec(label);
  if (week) return rulesWording().quota.week(week[1]!);
  return label.replace(/·\s*1 week/, rulesWording().quota.oneWeek);
}

export function resetText(at: number, now = Date.now()) {
  const ms = at - now;
  if (ms <= 0) return rulesWording().quota.now;
  const hours = ms / 3600000;
  if (hours < 1) return rulesWording().quota.minutes(Math.min(60, Math.max(1, Math.round(ms / 60000))));
  if (hours < 24) return rulesWording().quota.hours(Math.round(hours));
  return rulesWording().quota.on(rulesWording().quota.weekdays[new Date(at).getDay()]!);
}

export interface Quota {
  readonly level: QuotaLevel;
  /** 0..1. */
  readonly fill: number;
  readonly short: string;
  readonly text: string;
}

const money = (currency: string, amount: number) => `${currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `}${amount.toFixed(2)}`;

/** A runtime's account as a bottle. */
export function quotaOf(info: RuntimeInfo | undefined): Quota {
  const usage = info?.usage;
  const text = info?.quota?.text ?? rulesWording().quota.unreported;
  // Not logged in: nothing to work with, which is an empty bottle, not an unknown one.
  if (usage?.status === "login_required") return { level: "empty", fill: 0, short: rulesWording().quota.signedOut, text };
  if (usage?.status === "balance") {
    const first = usage.balances[0];
    return { level: usage.available ? "gold" : "empty", fill: usage.available ? 1 : 0.06, short: first ? money(first.currency, first.amount) : "", text };
  }
  const left = info?.quota?.left;
  return { level: quotaLevel(left), fill: left === undefined ? 0 : left / 100, short: left === undefined ? "" : `${numberText(left)}%`, text };
}

export function bottleSprite(q: Quota) {
  switch (q.level) {
    case "plenty":
      return q.fill >= 0.875 ? "energy-plenty-100" : q.fill >= 0.625 ? "energy-plenty-75" : "energy-plenty-50";
    case "low":
      return q.fill >= 0.325 ? "energy-low-40" : "energy-low-25";
    case "empty":
      return q.fill > 0.02 ? "energy-empty-10" : "energy-empty-0";
    case "unknown":
      return "energy-unknown";
    case "gold":
      return "energy-gold";
  }
}

/** Each runtime's farm machine; the farm's own agent wears the app's sprout. */
const machines: Record<string, string> = {
  claude: "machine-tractor",
  codex: "machine-watercart",
  opencode: "machine-wheelbarrow",
  pi: "machine-pump",
  cursor: "machine-seeder",
  grok: "machine-windmill",
  kimi: "machine-beehive",
  antigravity: "machine-lantern",
  vibevalley: "app-sprout",
  dsh: "machine-dsh",
};

export const machineOf = (runtime: string): string | undefined => machines[runtime];
