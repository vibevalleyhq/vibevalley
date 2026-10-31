// The seeds (seeds.json, template_catalog.json): the achievements and the issue templates, in the farm's language (a
// profile's templates are folders, template.ts; the runtimes' presets are runtime/presets.ts). The .en files say the same
// as the Chinese but for their words (seed.test.ts).

import { Schema } from "effect";

import * as S from "@vibevalley/protocol/schema";

import { localizedJson } from "@/base/json.ts";

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

const Seeds = Schema.Struct({ achievements: Schema.Array(AchievementDef) });
/** A template as template_catalog.json writes it: done may still hold {test}, {lint} and {build}; its text is made when
 * it is filled for a project (issue/brief.ts filledTemplate). */
const WrittenTemplate = Schema.Struct({ id: Schema.String, title: Schema.String, done: Schema.String });
export type WrittenTemplate = typeof WrittenTemplate.Type;
const WrittenKind = Schema.Struct({ id: Schema.String, name: Schema.String, icon: Schema.String, templates: Schema.Array(WrittenTemplate) });
export type WrittenKind = typeof WrittenKind.Type;
const Catalog = Schema.Struct({ kinds: Schema.Array(WrittenKind) });

const seeds = localizedJson(Seeds, seedsZh, seedsEn);
const catalog = localizedJson(Catalog, catalogZh, catalogEn);

/** In the order the page shows them. */
export const achievements = (): readonly AchievementDef[] => seeds().achievements;

/** The issue templates on the sowing form, in its order, as written. */
export const templateCatalog = (): readonly WrittenKind[] => catalog().kinds;
