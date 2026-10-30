// Times, numbers and money in words: how long ago, how long it took, the time of day, a moment, what a round cost.

import { currentLocale, t } from "@vibevalley/i18n";
import type { Spent } from "@vibevalley/protocol";

export function ago(at: number, now: number) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return t("web.base.time.justNow");
  if (s < 60) return t("web.base.time.secondsAgo", { s });
  if (s < 3600) return t("web.base.time.minutesAgo", { m: Math.round(s / 60) });
  if (s < 86400) return t("web.base.time.hoursAgo", { h: Math.floor(s / 3600) });
  return t("web.base.time.daysAgo", { d: Math.floor(s / 86400) });
}

export function tookText(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return t("web.base.time.seconds", { s });
  const m = Math.floor(s / 60);
  if (m < 60) return t("web.base.time.minutes", { m, s: s % 60 });
  return t("web.base.time.hours", { h: Math.floor(m / 60), m: m % 60 });
}

const two = (n: number) => String(n).padStart(2, "0");

export function wallClockText(at: number) {
  const d = new Date(Math.round(at));
  return `${d.getHours()}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** A whole number without its .0, as the server writes ids and counts. */
export const numberText = (v: number) => String(v);

/** A moment as a date and a time of day. */
export function momentText(at: number) {
  const d = new Date(Math.round(at));
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

// The server says money the same way (protocol.Yuan, SpentText) in what it writes to the chat.
export const yuan = (cny: number) => (cny > 0 && cny < 0.01 ? t("web.base.money.underCent") : `¥${cny.toFixed(2)}`);

const wan = (n: number) => (n >= 10000 ? big(n, n >= 100000 ? 0 : 1) : `${Math.round(n)}`);

/** A large count: ten thousands in Chinese (1.2 万), thousands in English (12k). */
export const big = (n: number, digits: number) => t("web.base.big", { n: currentLocale() === "zh" ? (n / 10000).toFixed(digits) : Math.round(n / 1000) });

export const spentText = (spent: Spent) =>
  [...(spent.cny !== undefined ? [t("web.base.money.about", { yuan: yuan(spent.cny) })] : []), `${wan(spent.tokens)} token`].join(" · ");

/** What a thrown or rejected value says: an Error's message, anything else as text. */
export const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** How long, in round words: 不到 1 分钟, 3 分钟, 2 小时, 4 天. */
export function spanText(ms: number) {
  const m = Math.floor(Math.max(0, ms) / 60_000);
  if (m < 1) return t("web.base.time.round.underMinute");
  if (m < 60) return t("web.base.time.round.minutes", { m });
  if (m < 60 * 24) return t("web.base.time.round.hours", { h: Math.floor(m / 60) });
  return t("web.base.time.round.days", { d: Math.floor(m / 60 / 24) });
}
