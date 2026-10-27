import type { Spent } from "@vibevalley/protocol";
import { rulesWording } from "./words/rules";
// Times, numbers and money in words: how long ago, how long it took, the time of day, a moment, what a round cost.

export function ago(at: number, now: number) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return rulesWording().time.justNow;
  if (s < 60) return rulesWording().time.secondsAgo(s);
  if (s < 3600) return rulesWording().time.minutesAgo(Math.round(s / 60));
  if (s < 86400) return rulesWording().time.hoursAgo(Math.floor(s / 3600));
  return rulesWording().time.daysAgo(Math.floor(s / 86400));
}

export function tookText(ms: number) {
  const s = Math.round(ms / 1000);
  if (s < 60) return rulesWording().time.seconds(s);
  const m = Math.floor(s / 60);
  if (m < 60) return rulesWording().time.minutes(m, s % 60);
  return rulesWording().time.hours(Math.floor(m / 60), m % 60);
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
export const yuan = (cny: number) => (cny > 0 && cny < 0.01 ? rulesWording().money.underCent : `¥${cny.toFixed(2)}`);

const wan = (n: number) => (n >= 10000 ? rulesWording().big(n, n >= 100000 ? 0 : 1) : `${Math.round(n)}`);

export const spentText = (spent: Spent) =>
  [...(spent.cny !== undefined ? [rulesWording().money.about(yuan(spent.cny))] : []), `${wan(spent.tokens)} token`].join(" · ");
