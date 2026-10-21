// The seeds (seeds.json, template_catalog.json): the achievements, the actions in words, the runtimes' presets and the
// templates.

import type { AchievementDef, Agent, RuntimeFacts, RuntimePreset, RuntimeSettings, SessionAction, TemplateKind } from "../shapes";
import seeds from "./seeds.json";
import catalog from "./template_catalog.json";

/** In the order the page shows them. */
export const achievements = seeds.achievements as AchievementDef[];

/** What each action is, in words. */
export const actionText = seeds.actionText as Record<SessionAction, string>;

/** The profiles a new farm starts with: a copy each call. */
export const seedAgents = (): Agent[] => structuredClone(seeds.agents) as Agent[];

export const defaultSettings = (): RuntimeSettings => ({ ...(seeds.defaultSettings as RuntimeSettings), env: {} });

/** Every runtime the farm knows, in the order the page shows them. */
export const runtimeIds = (): string[] => [...seeds.runtimeIds];

/** A runtime's name, look and blurb; one the farm has no look for gets the fallback, named by its id. */
export function presetOf(runtime: string): RuntimePreset {
  const found = (seeds.runtimePresets as RuntimePreset[]).find((p) => p.id === runtime);
  return structuredClone(found ?? { ...(seeds.fallbackPreset as RuntimePreset), id: runtime, label: runtime });
}

export const runtimeLabel = (runtime: string) => presetOf(runtime).label;

/** What the farm knows a runtime takes before probing it. */
export function factsOf(runtime: string): RuntimeFacts {
  const facts = (seeds.runtimeFacts as Record<string, RuntimeFacts>)[runtime];
  return facts ? structuredClone(facts) : ({ refused: {} } as RuntimeFacts);
}

/** The issue templates on the sowing form, in its order, as written: done still holds {test}, {lint} and {build}. A copy each call. */
export const templateCatalog = (): TemplateKind[] => structuredClone(catalog.kinds) as TemplateKind[];
