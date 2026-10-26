// A helper's look: the words for its animal and clothes, a random
// one for a new profile, and the drawing for each pose.

import { rulesWording } from "./words";
import { BuildValues, type Crop, HeadValues, type Look, type Outfit, OutfitValues, type Species, SpeciesValues } from "@vibevalley/protocol";

export const speciesLabel: Record<Species, string> = {
  bear: rulesWording().cast.species.bear,
  rabbit: rulesWording().cast.species.rabbit,
  fox: rulesWording().cast.species.fox,
  cat: rulesWording().cast.species.cat,
  owl: rulesWording().cast.species.owl,
  hedgehog: rulesWording().cast.species.hedgehog,
  raccoon: rulesWording().cast.species.raccoon,
};
export const outfitLabel: Record<Outfit, string> = {
  farmer: rulesWording().cast.outfit.farmer,
  gardener: rulesWording().cast.outfit.gardener,
  rain: rulesWording().cast.outfit.rain,
  winter: rulesWording().cast.outfit.winter,
};

export const swatches = {
  body: ["#f3e9da", "#e9e6de", "#e7e6fb", "#d3efe8", "#dfe4ea", "#f4e6d4", "#b9c4d1", "#3d434a", "#2a2e33", "#f6d8c8"],
  trim: ["#d9774f", "#24282d", "#6c70d8", "#2f9d8f", "#5b6470", "#b0503f", "#3a404a", "#d8dadc", "#c79a2e", "#8a5cc4"],
  hat: ["#f2b53a", "#e8804f", "#f4f3ee", "#2f3438", "#d9534f", "#4f86d9", "#9580e6", "#45bf8c", "#a9b4c2", "#ff8fb1"],
  eye: ["#a6f4ff", "#ffd25e", "#9dffb0", "#ff9de2", "#ffffff", "#ff7a5c"],
} as const;

const one = <T>(items: readonly T[], random: () => number) => items[Math.floor(random() * items.length)]!;

export function randomLook(random: () => number = Math.random): Look {
  return {
    species: one(SpeciesValues, random),
    outfit: one(OutfitValues, random),
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
  species: look?.species ?? SpeciesValues[hash(agentId) % SpeciesValues.length]!,
  outfit: look?.outfit ?? "farmer",
});

/** The sprite prefix of a profile's animal and outfit, as far as the drawings go. */
export function castPrefix(look: Look | undefined, agentId: string, has: (name: string) => boolean) {
  const { species, outfit } = castOf(look, agentId);
  return [`${species}-${outfit}`, `${species}-farmer`, "bear-farmer"].find((p) => has(`${p}-down`)) ?? "bear-farmer";
}

export type Pose = "idle" | "walk" | "think" | "work" | "cheer" | "worry";

const pixelPose: Record<Pose, string> = { idle: "down", think: "side", walk: "down-1", work: "work", cheer: "cheer", worry: "worry" };

/** Its outfit's, else the farmer's, else the farmer attention. */
export const castSprite = (cast: Cast, pose: Pose, has: (name: string) => boolean) =>
  [`${cast.species}-${cast.outfit}-${pixelPose[pose]}`, `${cast.species}-farmer-${pixelPose[pose]}`, `${cast.species}-farmer-down`].find(has) ??
  `${cast.species}-farmer-down`;

/** Without a cycle for this outfit, the stepping pose and the attention pose take turns. */
export function walkFrames(cast: Cast, has: (name: string) => boolean): string[] {
  const base = `${cast.species}-${cast.outfit}-down`;
  if (has(`${base}-1`)) return [`${base}-1`, base, has(`${base}-2`) ? `${base}-2` : base, base];
  return [castSprite(cast, "walk", has), castSprite(cast, "idle", has)];
}

export const cropSprite = (crop: Crop) => `plot-${crop}`;

/** The creator's stage: each pose on the bed it goes with. */
export const stagePoses: readonly { pose: Pose; label: string; crop: Crop }[] = [
  { pose: "idle", label: rulesWording().cast.pose.idle, crop: "empty" },
  { pose: "walk", label: rulesWording().cast.pose.walk, crop: "seeded" },
  { pose: "think", label: rulesWording().cast.pose.think, crop: "sprout" },
  { pose: "work", label: rulesWording().cast.pose.work, crop: "leafy" },
  { pose: "cheer", label: rulesWording().cast.pose.cheer, crop: "wheat" },
  { pose: "worry", label: rulesWording().cast.pose.worry, crop: "withered" },
];

/** A swatch, or the parchment colour for one that is not #rrggbb. */
export const hexColor = (hex: string) => (/^#[0-9a-f]{6}$/i.test(hex) ? hex : "#f1e8d8");
