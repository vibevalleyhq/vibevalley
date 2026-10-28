// This machine's choices, not the farm's: who the next job goes to, the pet by the orchestrator's door (its look is its
// profile's), and how the workbench looks and where the page opens. A phone and a desktop may want them apart, so they are
// kept in localStorage, not settings.json; without storage they last until the page closes.

import { type ThemeChoice, ThemeChoiceValues } from "@vibevalley/protocol/host";
import type { Accessor } from "solid-js";
import { createExternal } from "./external";

/** The workbench's size, in percent; the farm keeps its own whole-number scaling. */
export const ScaleValues = [90, 100, 110, 125] as const;
export type Scale = (typeof ScaleValues)[number];

/** Where / opens. */
export const StartValues = ["workbench", "farm"] as const;
export type Start = (typeof StartValues)[number];

export interface Prefs {
  /** Who the next job goes to: a profile's id, or "auto" for the orchestrator to choose. */
  readonly pick: string;
  readonly pet: string;
  readonly theme: ThemeChoice;
  readonly scale: Scale;
  readonly start: Start;
  /** A pane's width the owner dragged it to (ui/Splitter.tsx), by the pane's name; one not dragged has its default. */
  readonly widths: Readonly<Record<string, number>>;
}

const key = "vibevalley.prefs";

const fallback: Prefs = { pick: "auto", pet: "dog", theme: "system", scale: 100, start: "workbench", widths: {} };

const oneOf = <T>(values: readonly T[], v: unknown, d: T): T => (values.includes(v as T) ? (v as T) : d);

const widthsOf = (v: unknown): Record<string, number> =>
  typeof v === "object" && v !== null
    ? Object.fromEntries(Object.entries(v).filter((e): e is [string, number] => typeof e[1] === "number" && Number.isFinite(e[1])))
    : {};

function load(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "{}") as Partial<Record<keyof Prefs, unknown>>;
    const text = (v: unknown, d: string) => (typeof v === "string" && v !== "" ? v : d);
    return {
      pick: text(raw.pick, fallback.pick),
      pet: text(raw.pet, fallback.pet),
      theme: oneOf(ThemeChoiceValues, raw.theme, fallback.theme),
      scale: oneOf(ScaleValues, raw.scale, fallback.scale),
      start: oneOf(StartValues, raw.start, fallback.start),
      widths: widthsOf(raw.widths),
    };
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
  if ((Object.keys(next) as (keyof Prefs)[]).every((k) => next[k] === prefs[k])) return;
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
export const setTheme = (theme: ThemeChoice) => set({ theme });
export const setScale = (scale: Scale) => set({ scale });
export const setStart = (start: Start) => set({ start });
/** A pane's width; none puts it back to its default. */
export const setWidth = (pane: string, width: number | undefined) => {
  const { [pane]: _was, ...rest } = prefs.widths;
  set({ widths: width === undefined ? rest : { ...rest, [pane]: width } });
};

/** One of the choices, following it. */
export function usePrefs<T>(select: (p: Prefs) => T): Accessor<T> {
  const all = createExternal(subscribePrefs, prefsNow);
  return () => select(all());
}
