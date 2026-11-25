import { t } from "@vibevalley/i18n";
import { BuildValues, HeadValues, type Look, type OrchestratorLook, type Outfit, OutfitValues, type Species, SpeciesValues } from "@vibevalley/protocol";

export const speciesLabel: Record<Species, string> = {
  bear: t("web.base.cast.species.bear"),
  rabbit: t("web.base.cast.species.rabbit"),
  fox: t("web.base.cast.species.fox"),
  cat: t("web.base.cast.species.cat"),
  owl: t("web.base.cast.species.owl"),
  hedgehog: t("web.base.cast.species.hedgehog"),
  raccoon: t("web.base.cast.species.raccoon"),
};
export const outfitLabel: Record<Outfit, string> = {
  farmer: t("web.base.cast.outfit.farmer"),
  gardener: t("web.base.cast.outfit.gardener"),
  rain: t("web.base.cast.outfit.rain"),
  winter: t("web.base.cast.outfit.winter"),
};

export const swatches = {
  body: ["#f3e9da", "#e9e6de", "#e7e6fb", "#d3efe8", "#dfe4ea", "#f4e6d4", "#b9c4d1", "#3d434a", "#2a2e33", "#f6d8c8"],
  trim: ["#d9774f", "#24282d", "#6c70d8", "#2f9d8f", "#5b6470", "#b0503f", "#3a404a", "#d8dadc", "#c79a2e", "#8a5cc4"],
  hat: ["#f2b53a", "#e8804f", "#f4f3ee", "#2f3438", "#d9534f", "#4f86d9", "#9580e6", "#45bf8c", "#a9b4c2", "#ff8fb1"],
  eye: ["#a6f4ff", "#ffd25e", "#9dffb0", "#ff9de2", "#ffffff", "#ff7a5c"],
} as const;

const one = <T>(items: readonly [T, ...T[]], random: () => number): T => items[Math.floor(random() * items.length)] ?? items[0];

export function randomLook(random: () => number = Math.random): Look {
  return {
    species: one(SpeciesValues, random),
    outfit: one(OutfitValues, random),
    orchestrator: null,
    build: one(BuildValues, random),
    head: one(HeadValues, random),
    body: one(swatches.body, random),
    trim: one(swatches.trim, random),
    hat: one(swatches.hat, random),
    eye: one(swatches.eye, random),
  };
}

// JavaScript's charCodeAt over the code points: the server fills a profile without a look by the same pick.
function hash(s: string) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

export interface Cast {
  readonly species: Species;
  readonly outfit: Outfit;
}

export const castOf = (look: Look | undefined, agentId: string): Cast => ({
  species: look?.species ?? SpeciesValues[hash(agentId) % SpeciesValues.length] ?? "cat",
  outfit: look?.outfit ?? "farmer",
});

export type Pose = "idle" | "walk" | "think" | "work" | "cheer" | "worry";

export const stagePoses: readonly { pose: Pose; label: string }[] = [
  { pose: "idle", label: t("web.base.cast.pose.idle") },
  { pose: "walk", label: t("web.base.cast.pose.walk") },
  { pose: "think", label: t("web.base.cast.pose.think") },
  { pose: "work", label: t("web.base.cast.pose.work") },
  { pose: "cheer", label: t("web.base.cast.pose.cheer") },
  { pose: "worry", label: t("web.base.cast.pose.worry") },
];

export const orchestratorLooks: readonly { readonly id: OrchestratorLook; readonly name: string; readonly blurb: string }[] = [
  { id: "farmer", name: t("web.orchestrator.looks.farmer.name"), blurb: t("web.orchestrator.looks.farmer.blurb") },
  { id: "foreman", name: t("web.orchestrator.looks.foreman.name"), blurb: t("web.orchestrator.looks.foreman.blurb") },
  { id: "auntie", name: t("web.orchestrator.looks.auntie.name"), blurb: t("web.orchestrator.looks.auntie.blurb") },
  { id: "grandpa", name: t("web.orchestrator.looks.grandpa.name"), blurb: t("web.orchestrator.looks.grandpa.blurb") },
  { id: "gardener", name: t("web.orchestrator.looks.gardener.name"), blurb: t("web.orchestrator.looks.gardener.blurb") },
  { id: "robot", name: t("web.orchestrator.looks.robot.name"), blurb: t("web.orchestrator.looks.robot.blurb") },
];

/** A swatch, or the parchment colour for one that is not #rrggbb. */
export const hexColor = (hex: string) => (/^#[0-9a-f]{6}$/iu.test(hex) ? hex : "#f1e8d8");
