// Words the HUD shows, from the frame: the clock, the warehouse, the runtimes' quotas, what a helper is doing, a plot's
// title and what the manager last said.

import type { Chat, CoreState, Crop, Doing, Issue, RuntimeInfo, Session } from "@vibevalley/protocol";
import { generalOf, messagesIn } from "../../rules/chat";
import { numberText } from "../kit";
import { beds, cropLabel, type Bed } from "../world/plots";

/** To five minutes; `tod` 0..1, 0.5 is noon. */
export function clockText(tod: number) {
  const minutes = Math.floor(tod * 24 * 60);
  const m = minutes % 60;
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(m - (m % 5)).padStart(2, "0")}`;
}

export const thousands = (n: number) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** The issues harvested into their main branch, newest first: the warehouse. */
export const harvestedOf = (s: CoreState | undefined): Issue[] =>
  (s?.issues ?? []).filter((i) => i.closed === "merged").sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0));

/** A switched-off runtime's account is not the farm's business. */
export const usableRuntimes = (all: readonly RuntimeInfo[]) => all.filter((r) => r.installation.status === "available" && r.settings.enabled);

export type QuotaLevel = "plenty" | "low" | "gold" | "empty" | "unknown";

/** Below this much left (percent) the farm warns and the manager sends someone else if it can (protocol.QuotaLow). */
export const quotaLow = 15;

/** How full a quota's bottle is drawn, by the share left. */
export const quotaLevel = (left: number | undefined): QuotaLevel => (left === undefined ? "unknown" : left < quotaLow ? "empty" : left < 50 ? "low" : "plenty");

/** Runtimes name their windows in English; the common ones read better in Chinese. */
export function windowLabel(label: string) {
  if (label === "Current session") return "当前会话";
  if (label === "Weekly included usage") return "本周额度";
  const week = /^Current week \((.+)\)$/.exec(label);
  if (week) return `本周（${week[1] === "all models" ? "全部模型" : week[1]}）`;
  return label.replace(/·\s*1 week/, "· 一周");
}

const weekday = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

export function resetText(at: number, now = Date.now()) {
  const ms = at - now;
  if (ms <= 0) return "马上重置";
  const hours = ms / 3600000;
  if (hours < 1) return `${Math.min(60, Math.max(1, Math.round(ms / 60000)))} 分钟后重置`;
  if (hours < 24) return `${Math.round(hours)} 小时后重置`;
  return `${weekday[new Date(at).getDay()]}重置`;
}

const nothing: Doing = { action: "none", label: "" };

export const doingOf = (h: Session): Doing => (h.phase._tag === "working" ? h.phase.doing : nothing);

/** The levels that clear a locked bed: the level-up banner says so. */
export const clearingLevels = new Set(beds.flatMap((b) => (b.unlockLevel === undefined ? [] : [b.unlockLevel])));

export function plotTitle(bed: Bed, session: Session | undefined, crop: Crop) {
  if (bed.unlockLevel !== undefined) return crop === "locked" ? "没开垦的地" : "花坛";
  if (!session) return `第 ${bed.station + 1} 块地 · 空地`;
  return `${session.name} · ${cropLabel[crop]}`;
}

/** The manager's last typed line in the general channel (voice lines are not on the web yet). */
export function lastManagerSaid(chat: Chat | undefined) {
  const general = generalOf(chat);
  if (!general) return undefined;
  const typed = messagesIn(chat, general.id)
    .filter((m) => m.fromKind === "manager" && m.kind === "chat")
    .at(-1);
  return typed && { key: `m${typed.id}`, text: typed.text, final: typed.final, at: typed.at };
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
  const text = info?.quota?.text ?? "不报额度";
  // Not logged in: nothing to work with, which is an empty bottle, not an unknown one.
  if (usage?.status === "login_required") return { level: "empty", fill: 0, short: "没登录", text };
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
