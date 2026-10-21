// A helper's look: the words for its animal and clothes, a random
// one for a new profile, and the drawing for each pose.

import { BuildValues, type Crop, HeadValues, type Look, type Outfit, OutfitValues, type Species, SpeciesValues } from "@vibevalley/protocol";

export const speciesLabel: Record<Species, string> = { bear: "熊", rabbit: "兔子", fox: "小狐狸", cat: "猫", owl: "猫头鹰", hedgehog: "刺猬", raccoon: "浣熊" };
export const outfitLabel: Record<Outfit, string> = { farmer: "农夫", gardener: "园丁", rain: "雨衣", winter: "冬装" };

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

export type Pose = "idle" | "walk" | "think" | "work" | "cheer" | "worry";

const pixelPose: Record<Pose, string> = { idle: "down", think: "side", walk: "down-1", work: "work", cheer: "cheer", worry: "worry" };

/** Its outfit's, else the farmer's, else the farmer standing. */
export const castSprite = (cast: Cast, pose: Pose, has: (name: string) => boolean) =>
  [`${cast.species}-${cast.outfit}-${pixelPose[pose]}`, `${cast.species}-farmer-${pixelPose[pose]}`, `${cast.species}-farmer-down`].find(has) ??
  `${cast.species}-farmer-down`;

/** Without a cycle for this outfit, the stepping pose and the standing pose take turns. */
export function walkFrames(cast: Cast, has: (name: string) => boolean): string[] {
  const base = `${cast.species}-${cast.outfit}-down`;
  if (has(`${base}-1`)) return [`${base}-1`, base, has(`${base}-2`) ? `${base}-2` : base, base];
  return [castSprite(cast, "walk", has), castSprite(cast, "idle", has)];
}

export const cropSprite = (crop: Crop) => `plot-${crop}`;

/** The creator's stage: each pose on the bed it goes with. */
export const stagePoses: readonly { pose: Pose; label: string; crop: Crop }[] = [
  { pose: "idle", label: "待命", crop: "empty" },
  { pose: "walk", label: "走过来", crop: "seeded" },
  { pose: "think", label: "琢磨", crop: "sprout" },
  { pose: "work", label: "干活", crop: "leafy" },
  { pose: "cheer", label: "做完", crop: "wheat" },
  { pose: "worry", label: "长虫了", crop: "withered" },
];

/** A swatch, or the parchment colour for one that is not #rrggbb. */
export const hexColor = (hex: string) => (/^#[0-9a-f]{6}$/i.test(hex) ? hex : "#f1e8d8");
