import { list, t } from "@vibevalley/i18n";
import type { AccountUsage, RuntimeInfo, RuntimeQuota } from "@vibevalley/protocol";

import { yuan } from "./money.ts";
import { runtimeLabel } from "./presets.ts";

const two = (n: number) => String(n).padStart(2, "0");

function whenText(at: number): string {
  const d = new Date(at);
  return t("server.runtime.date", { month: d.getMonth() + 1, day: d.getDate(), time: `${two(d.getHours())}:${two(d.getMinutes())}` });
}

/** Why a runtime takes no work now because of money (quota gone, balance gone, the day's budget spent); "" when it does. */
export function moneyStop(info: RuntimeInfo | undefined): string {
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

/** The least left of any window, 0 at the least; undefined when the usage has no windows. */
export function quotaLeft(usage: AccountUsage | null): number | undefined {
  if (usage?.status !== "ok" || usage.windows.length === 0) return undefined;
  return Math.max(0, Math.min(...usage.windows.map((w) => 100 - w.usedPercent)));
}

const balanceText = (currency: string, amount: number) => (currency === "CNY" ? "¥" : currency === "USD" ? "$" : currency + " ") + amount.toFixed(2);

export function quotaText(usage: AccountUsage | null): string {
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

export function quotaOf(usage: AccountUsage | null): RuntimeQuota {
  const left = quotaLeft(usage);
  return { ...(left !== undefined ? { left } : {}), text: quotaText(usage) };
}
