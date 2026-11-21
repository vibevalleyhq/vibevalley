import { effect, lifecycle } from "nsh";

import { dayKey } from "./days";

function nextLocalMidnight(now: number): number {
  const next = new Date(now);
  next.setHours(24, 0, 0, 0);
  return next.getTime();
}

const listeners = new Set<() => void>();
let observed: string | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

const get = () => dayKey(Date.now());

function refresh() {
  clearTimeout(timer);
  timer = undefined;
  const now = Date.now();
  const day = dayKey(now);
  if (day !== observed) {
    observed = day;
    for (const notify of listeners) notify();
  }
  if (listeners.size > 0) timer = setTimeout(refresh, nextLocalMidnight(now) - now);
}

export const localDay = {
  get,
  subscribe: (notify: () => void) => {
    listeners.add(notify);
    if (listeners.size === 1) {
      observed = get();
      refresh();
    }
    effect(() => {
      if (lifecycle() === "active") refresh();
    });
    notify();
    return () => {
      listeners.delete(notify);
      if (listeners.size !== 0) return;
      clearTimeout(timer);
      timer = undefined;
    };
  },
};
