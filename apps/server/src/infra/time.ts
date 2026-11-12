import type { Clock } from "@vibevalley/async";
import { sleep } from "@vibevalley/async";

/** The time as the server reads it: a Clock, and a timer that can be called off. */
export interface Time extends Clock {
  /** Runs f after ms unless the function it returns is called first. */
  readonly after: (ms: number, f: () => void) => () => void;
}

/** The wall clock, for code with no service to ask: a class tested on its own, the command line. */
export const wallTime: Time = {
  now: () => Date.now(),
  sleep,
  // Kept alive by nothing: a command line's pending fold or tick does not hold it open.
  after: (ms, f) => {
    const timer = setTimeout(f, Math.max(0, ms));
    timer.unref();
    return () => clearTimeout(timer);
  },
};

/** A deadline on a real process or network call (a runtime's probe of its CLI): real time, whatever the Clock says, and it keeps nothing alive. */
export const withinRealTime = <A>(p: Promise<A>, ms: number, fallback: A): Promise<A> =>
  Promise.race([p.catch(() => fallback), new Promise<A>((resolve) => setTimeout(() => resolve(fallback), ms).unref())]);

/** A deadline on a real process (a command's timeout, the grace before SIGKILL): runs f after ms of real time, whatever the Clock says. */
export const afterRealTime = (ms: number, f: () => void, options: { readonly unref?: boolean } = {}): (() => void) => {
  const timer = setTimeout(f, Math.max(0, ms));
  if (options.unref === true) timer.unref();
  return () => clearTimeout(timer);
};

const pad = (n: number) => String(n).padStart(2, "0");

/** To the minute, in this machine's zone: what an input says the time is, so that it does not change between two requests a
 * few seconds apart. */
export const localeMinute = (ms: number) => {
  const t = localParts(ms);
  return `${t.year}/${t.month}/${t.day} ${pad(t.hour)}:${pad(t.minute)}`;
};

/** An instant's calendar and clock in this machine's zone; month counts from 1. */
export const localParts = (ms: number) => {
  const d = new Date(ms);
  return {
    year: d.getFullYear(),
    month: d.getMonth() + 1,
    day: d.getDate(),
    hour: d.getHours(),
    minute: d.getMinutes(),
    second: d.getSeconds(),
    millis: d.getMilliseconds(),
    weekDay: d.getDay(),
  };
};
