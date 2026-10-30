// The seeds (seeds.json, template_catalog.json): the achievements, the runtimes' presets and settings, and the issue
// templates, in the farm's language (a profile's templates are folders, template.ts). The .en files say the same as the Chinese but for their words (seed.test.ts).

import { Schema } from "effect";

import { currentLocale } from "@vibevalley/i18n";
import type { RuntimeFacts, RuntimePreset, RuntimeSettings } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import seedsEn from "./seeds.en.json";
import seedsZh from "./seeds.json";
import catalogEn from "./template_catalog.en.json";
import catalogZh from "./template_catalog.json";

/** An achievement as seeds.json defines it; the game says it in the owner's words (game/view.ts). */
const AchievementDef = Schema.Struct({
  id: Schema.String,
  category: S.AchievementCategory,
  title: Schema.String,
  tierTitles: Schema.optionalKey(Schema.Array(Schema.String)),
  detail: Schema.String,
  tiers: Schema.Array(Schema.Finite),
  coins: Schema.Array(Schema.Finite),
  unit: Schema.optionalKey(Schema.String),
});
export type AchievementDef = typeof AchievementDef.Type;

const Seeds = Schema.Struct({
  achievements: Schema.Array(AchievementDef),
  defaultSettings: S.RuntimeSettings,
  runtimeIds: Schema.Array(Schema.String),
  runtimePresets: Schema.Array(S.RuntimePreset),
  fallbackPreset: S.RuntimePreset,
  runtimeFacts: Schema.Record(Schema.String, S.RuntimeFacts),
});
/** A template as template_catalog.json writes it: done may still hold {test}, {lint} and {build}; its text is made when
 * it is filled for a project (issue/brief.ts filledTemplate). */
const WrittenTemplate = Schema.Struct({ id: Schema.String, title: Schema.String, done: Schema.String });
export type WrittenTemplate = typeof WrittenTemplate.Type;
const WrittenKind = Schema.Struct({ id: Schema.String, name: Schema.String, icon: Schema.String, templates: Schema.Array(WrittenTemplate) });
export type WrittenKind = typeof WrittenKind.Type;
const Catalog = Schema.Struct({ kinds: Schema.Array(WrittenKind) });

// Read once per language; a seed file that does not fit its shape stops the server at its first use.
const read = <A, I>(schema: Schema.Codec<A, I>, zh: unknown, en: unknown) => {
  const kept = new Map<string, A>();
  return (): A => {
    const locale = currentLocale() === "en" ? "en" : "zh";
    let got = kept.get(locale);
    if (got === undefined) kept.set(locale, (got = Schema.decodeUnknownSync(schema)(locale === "en" ? en : zh)));
    return got;
  };
};
const seeds = read(Seeds, seedsZh, seedsEn);
const catalog = read(Catalog, catalogZh, catalogEn);

/** In the order the page shows them. */
export const achievements = (): readonly AchievementDef[] => seeds().achievements;

export const defaultSettings = (): RuntimeSettings => ({ ...seeds().defaultSettings, env: {} });

/** Every runtime the farm knows, in the order the page shows them. */
export const runtimeIds = (): string[] => [...seeds().runtimeIds];

/** A runtime's name, look and blurb; one the farm has no look for gets the fallback, named by its id. */
export function presetOf(runtime: string): RuntimePreset {
  const found = seeds().runtimePresets.find((p) => p.id === runtime);
  return structuredClone(found ?? { ...seeds().fallbackPreset, id: runtime, label: runtime });
}

export const runtimeLabel = (runtime: string) => presetOf(runtime).label;

/** What the farm knows a runtime takes before probing it: for one it has no word on, nothing beyond a prompt. */
export function factsOf(runtime: string): RuntimeFacts {
  const facts = seeds().runtimeFacts[runtime];
  return facts ? structuredClone(facts) : { steer: false, refused: {}, capabilities: [], inProcess: false };
}

/** The issue templates on the sowing form, in its order, as written. */
export const templateCatalog = (): readonly WrittenKind[] => catalog().kinds;
