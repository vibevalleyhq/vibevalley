// This machine's choices, not the farm's: who the next job goes to and where the last one went, the pet by the
// orchestrator's door (its look is its profile's), and how the workbench looks and where the page opens. A phone and a
// desktop may want them apart, so they are kept on the machine (stored.ts), not in settings.json. One key, which
// public/opening.html also reads for the theme and the start before any script runs.

import { Schema } from "effect";
import type { Accessor } from "solid-js";

import { ThemeChoice } from "@vibevalley/protocol/host";

import { defineStored, orFallback } from "./stored";

/** The workbench's size, in percent; the farm keeps its own whole-number scaling. */
export const ScaleValues = [90, 100, 110, 125] as const;
export type Scale = (typeof ScaleValues)[number];

/** Where / opens. */
export const StartValues = ["workbench", "farm"] as const;
export type Start = (typeof StartValues)[number];

const PrefsSchema = Schema.Struct({
  /** Who the next job goes to: a profile's id, or "auto" for the orchestrator to choose. */
  pick: orFallback(Schema.NonEmptyString, "auto"),
  /** The project the last issue was given to on this machine ("" none), for the next quick add. */
  project: orFallback(Schema.String, ""),
  pet: orFallback(Schema.NonEmptyString, "dog"),
  theme: orFallback(ThemeChoice, "system"),
  scale: orFallback(Schema.Literals(ScaleValues), 100),
  start: orFallback(Schema.Literals(StartValues), "workbench"),
  /** A pane's width the owner dragged it to (ui/Splitter.tsx), by the pane's name; one not dragged has its default. */
  widths: orFallback(Schema.Record(Schema.String, Schema.Finite), {}),
});

export type Prefs = typeof PrefsSchema.Type;

const prefs = defineStored("prefs", PrefsSchema, { pick: "auto", project: "", pet: "dog", theme: "system", scale: 100, start: "workbench", widths: {} });

/** The choices now; read in a computation or a component, it follows them. */
export const prefsNow = prefs.get;

export const subscribePrefs = prefs.subscribe;

const set = (patch: Partial<Prefs>) => prefs.update((p) => ({ ...p, ...patch }));

export const setPick = (pick: string) => set({ pick });
export const setPet = (pet: string) => set({ pet });
export const setTheme = (theme: ThemeChoice) => set({ theme });
export const setScale = (scale: Scale) => set({ scale });
export const setStart = (start: Start) => set({ start });
/** A pane's width; none puts it back to its default. */
export const setWidth = (pane: string, width: number | undefined) =>
  prefs.update((p) => {
    const { [pane]: _was, ...rest } = p.widths;
    return { ...p, widths: width === undefined ? rest : { ...rest, [pane]: width } };
  });

/** Who and where an issue was given to, for the next quick add and the farm's next job: "" for no one is the orchestrator's. */
export const rememberPick = (agent: string, project: string) => {
  if (!agent && !project) return;
  set({ pick: agent || "auto", project });
};

/** One of the choices, following it. */
export const usePrefs =
  <T>(select: (p: Prefs) => T): Accessor<T> =>
  () =>
    select(prefs.get());
