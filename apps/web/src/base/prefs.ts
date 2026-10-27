// This machine's choices that the workbench and the farm both read: who the next job goes to, the orchestrator's look
// and the pet by his door. Kept in localStorage; without storage they last until the page closes.

import type { Accessor } from "solid-js";
import { createExternal } from "./external";

export interface Prefs {
  /** Who the next job goes to: a profile's id, or "auto" for the orchestrator to choose. */
  readonly pick: string;
  /** The orchestrator's look (farm/kit/looks.ts ids; "farmer" is the plain one). */
  readonly orchestratorLook: string;
  readonly pet: string;
}

const key = "vibevalley.prefs";

const fallback: Prefs = { pick: "auto", orchestratorLook: "farmer", pet: "dog" };

function load(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "{}") as Partial<Record<keyof Prefs, unknown>>;
    const text = (v: unknown, d: string) => (typeof v === "string" && v !== "" ? v : d);
    return { pick: text(raw.pick, fallback.pick), orchestratorLook: text(raw.orchestratorLook, fallback.orchestratorLook), pet: text(raw.pet, fallback.pet) };
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
  if (next.pick === prefs.pick && next.orchestratorLook === prefs.orchestratorLook && next.pet === prefs.pet) return;
  prefs = next;
  try {
    localStorage.setItem(key, JSON.stringify(prefs));
  } catch {
    // No storage: the choice lasts until the page closes.
  }
  for (const l of listeners) l();
}

export const setPick = (pick: string) => set({ pick });
export const setOrchestratorLook = (orchestratorLook: string) => set({ orchestratorLook });
export const setPet = (pet: string) => set({ pet });

/** One of the choices, following it. */
export function usePrefs<T>(select: (p: Prefs) => T): Accessor<T> {
  const all = createExternal(subscribePrefs, prefsNow);
  return () => select(all());
}
