import { z } from "zod";

import * as S from "@vibevalley/protocol/schema";

import { localizedJson } from "#/base/json.ts";

import seedsEn from "./seeds.en.json";
import seedsZh from "./seeds.json";

/** An achievement as seeds.json defines it; the game says it in the user's words (game/view.ts). */
const AchievementDef = z.object({
  id: z.string(),
  category: S.AchievementCategory,
  title: z.string(),
  tierTitles: z.exactOptional(z.array(z.string())),
  detail: z.string(),
  tiers: z.array(z.number()),
  coins: z.array(z.number()),
  unit: z.exactOptional(z.string()),
});
export type AchievementDef = z.infer<typeof AchievementDef>;

const Seeds = z.object({ achievements: z.array(AchievementDef) });
const seeds = localizedJson(Seeds, seedsZh, seedsEn);

/** In the order the page shows them. */
export const achievements = (): readonly AchievementDef[] => seeds().achievements;
