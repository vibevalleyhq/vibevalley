// The seeds (seeds.json, template_catalog.json): the achievements, the runtimes' presets and settings, and the issue
// templates, in the farm's language (a profile's templates are folders, template.ts). The .en files say the same as the Chinese but for their words (seed.test.ts).

import type { AchievementDef, RuntimeFacts, RuntimePreset, RuntimeSettings, TemplateKind } from "@vibevalley/protocol";
import { currentLocale } from "@vibevalley/protocol/words";
import seedsZh from "./seeds.json";
import seedsEn from "./seeds.en.json";
import catalogZh from "./template_catalog.json";
import catalogEn from "./template_catalog.en.json";

const seeds = () => (currentLocale() === "en" ? seedsEn : seedsZh);
const catalog = () => (currentLocale() === "en" ? catalogEn : catalogZh);

/** In the order the page shows them. */
export const achievements = () => seeds().achievements as AchievementDef[];

export const defaultSettings = (): RuntimeSettings => ({
  ...(seeds().defaultSettings as RuntimeSettings),
  env: {},
});

/** Every runtime the farm knows, in the order the page shows them. */
export const runtimeIds = (): string[] => [...seeds().runtimeIds];

/** A runtime's name, look and blurb; one the farm has no look for gets the fallback, named by its id. */
export function presetOf(runtime: string): RuntimePreset {
  const found = (seeds().runtimePresets as RuntimePreset[]).find((p) => p.id === runtime);
  return structuredClone(found ?? { ...(seeds().fallbackPreset as RuntimePreset), id: runtime, label: runtime });
}

export const runtimeLabel = (runtime: string) => presetOf(runtime).label;

/** What the farm knows a runtime takes before probing it. */
export function factsOf(runtime: string): RuntimeFacts {
  const facts = (seeds().runtimeFacts as Record<string, RuntimeFacts>)[runtime];
  return facts ? structuredClone(facts) : ({ refused: {} } as RuntimeFacts);
}

/** The issue templates on the sowing form, in its order, as written: done still holds {test}, {lint} and {build}. A copy each call. */
export const templateCatalog = (): TemplateKind[] => structuredClone(catalog().kinds) as TemplateKind[];
