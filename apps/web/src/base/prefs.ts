// This machine's choices that the workbench and the farm both read: who the next job goes to and the pet by the
// orchestrator's door (its look is its profile's). Kept in localStorage; without storage they last until the page closes.

import type { Accessor } from "solid-js";
import { createExternal } from "./external";

export interface Prefs {
  /** Who the next job goes to: a profile's id, or "auto" for the orchestrator to choose. */
  readonly pick: string;
  readonly pet: string;
}

const key = "vibevalley.prefs";

const fallback: Prefs = { pick: "auto", pet: "dog" };

function load(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "{}") as Partial<Record<keyof Prefs, unknown>>;
    const text = (v: unknown, d: string) => (typeof v === "string" && v !== "" ? v : d);
    return { pick: text(raw.pick, fallback.pick), pet: text(raw.pet, fallback.pet) };
  } catch {
    return fallback;
  }
}

let prefs = load();
const listeners = new Set<() => void>();

export const prefsNow = () => prefs;

export const subscribePrefs = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

function set(patch: Partial<Prefs>) {
  const next = { ...prefs, ...patch };
  if (next.pick === prefs.pick && next.pet === prefs.pet) return;
  prefs = next;
  try {
    localStorage.setItem(key, JSON.stringify(prefs));
  } catch {
    // No storage: the choice lasts until the page closes.
  }
  for (const l of listeners) l();
}

export const setPick = (pick: string) => set({ pick });
export const setPet = (pet: string) => set({ pet });

/** One of the choices, following it. */
export function usePrefs<T>(select: (p: Prefs) => T): Accessor<T> {
  const all = createExternal(subscribePrefs, prefsNow);
  return () => select(all());
}
