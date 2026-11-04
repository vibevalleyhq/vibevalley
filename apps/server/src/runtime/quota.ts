import { list, t } from "@vibevalley/i18n";
import type { AccountUsage, RuntimeQuota } from "@vibevalley/protocol";

/** CNY in words; anything positive under a cent says so, so that a spent amount never reads as ¥0.00. */
export const yuan = (cny: number) => (cny > 0 && cny < 0.01 ? t("server.runtime.lessThanCent") : "¥" + cny.toFixed(2));

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
