import { z } from "zod";

import type * as T from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { localizedJson } from "#/base/json.ts";

import seedsEn from "./seeds.en.json";
import seedsZh from "./seeds.json";
import catalogEn from "./template_catalog.en.json";
import catalogZh from "./template_catalog.json";

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
/** A template as template_catalog.json writes it: done may still hold {test}, {lint} and {build}. */
const WrittenTemplate = z.object({ id: z.string(), title: z.string(), done: z.string() });
export type WrittenTemplate = z.infer<typeof WrittenTemplate>;
const WrittenKind = z.object({ id: z.string(), name: z.string(), icon: z.string(), templates: z.array(WrittenTemplate) });
export type WrittenKind = z.infer<typeof WrittenKind>;
const Catalog = z.object({ kinds: z.array(WrittenKind) });

const seeds = localizedJson(Seeds, seedsZh, seedsEn);
const catalog = localizedJson(Catalog, catalogZh, catalogEn);

/** In the order the page shows them. */
export const achievements = (): readonly AchievementDef[] => seeds().achievements;

/** The issue templates on the sowing form, in its order, as written. */
export const templateCatalog = (): readonly WrittenKind[] => catalog().kinds;

/** An agent as the farm keeps it, with defaults: a test says only the parts it is about. */
export const sampleAgent = (a: Partial<T.Agent> & Pick<T.Agent, "id">): T.Agent => ({
  name: a.id,
  role: "worker",
  duty: "",
  enabled: true,
  runtime: "pi",
  model: "",
  effort: "",
  persona: "",
  personaMode: "append",
  skills: [],
  mcpServers: [],
  disallowedTools: [],
  env: {},
  workdir: "",
  worktree: false,
  tags: [],
  look: { species: null, outfit: null, orchestrator: null, build: "biped", head: "rounded", body: "", trim: "", hat: "", eye: "" },
  ...a,
});
