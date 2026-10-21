// What moves over the title's picture: clouds crossing, smoke from the chimney, plants
// swaying along the bottom, seeds blowing off the dandelions, the farmer and the pet on the hill. Everything is placed in
// the scene's own pixels (1536 × 1024, as the pictures are drawn), so it stays put however the screen crops it.

import type { TitleScene } from "./scene";

export const sceneW = 1536;
export const sceneH = 1024;

/** Each sprite's size in the scene's pixels (apps/web/public/title/sprites.json). */
export type TitleSprites = Readonly<Record<string, { readonly w: number; readonly h: number }>>;

/** A sprite's picture, and its size as a share of the scene, so it scales with it. */
export function spriteOf(sizes: TitleSprites, name: string, scale = 1) {
  const size = sizes[name] ?? { w: 0, h: 0 };
  return { src: `/title/${name}.png`, w: (size.w * scale) / sceneW, h: (size.h * scale) / sceneH };
}

/** Where the farmhouse chimney's mouth is, the same in every scene. */
export const chimney = { x: 1068 / sceneW, y: 330 / sceneH };

export interface Cloud {
  readonly sprite: string;
  readonly y: number;
  readonly scale: number;
  /** Seconds to cross the sky; and how far across it is when the page opens (a negative delay). */
  readonly duration: number;
  readonly delay: number;
}

// High in the sky, above where the smoke thins out.
export const clouds: readonly Cloud[] = [
  { sprite: "cloud-big-1", y: -0.01, scale: 0.45, duration: 160, delay: -40 },
  { sprite: "cloud-wisp-1", y: 0.06, scale: 0.45, duration: 120, delay: -95 },
  { sprite: "cloud-mid-2", y: 0.015, scale: 0.38, duration: 190, delay: -150 },
];

export interface Plant {
  readonly sprite: string;
  /** Its middle, as a share of the scene's width; it stands on the bottom edge. */
  readonly x: number;
  readonly scale: number;
  /** Seconds per sway, and degrees each way. */
  readonly sway: number;
  readonly lean: number;
}

// Left and middle only: the farmer and the dog stand at the right.
export const plants: readonly Plant[] = [
  { sprite: "fern", x: 0.02, scale: 0.5, sway: 4.6, lean: 1.5 },
  { sprite: "grass-tall", x: 0.11, scale: 0.45, sway: 3.4, lean: 2.5 },
  { sprite: "dandelion-3", x: 0.2, scale: 0.42, sway: 3.9, lean: 3 },
  { sprite: "grass-daisy", x: 0.31, scale: 0.36, sway: 4.2, lean: 2 },
  { sprite: "dandelion-2", x: 0.47, scale: 0.36, sway: 3.6, lean: 3 },
  { sprite: "grass-yellow", x: 0.985, scale: 0.4, sway: 4, lean: 2 },
];

/** Seeds blow off the dandelions (plants' 3rd and 5th) up and to the right across the scene. */
export const seeds: readonly { readonly sprite: string; readonly from: number; readonly duration: number; readonly delay: number }[] = [
  { sprite: "seed-1", from: 0.2, duration: 16, delay: -2 },
  { sprite: "seed-2", from: 0.47, duration: 19, delay: -9 },
  { sprite: "seed-3", from: 0.2, duration: 22, delay: -15 },
  { sprite: "seed-4", from: 0.47, duration: 17, delay: -5 },
  { sprite: "seed-2", from: 0.2, duration: 25, delay: -20 },
];

/** The puffs, one after another out of the chimney: small and pale, close together, so they read as one plume. */
export const puffs: readonly { readonly sprite: string; readonly scale: number }[] = [
  { sprite: "puff-1", scale: 0.3 },
  { sprite: "puff-2", scale: 0.26 },
  { sprite: "wisp-1", scale: 0.32 },
  { sprite: "puff-1", scale: 0.28 },
  { sprite: "puff-2", scale: 0.3 },
  { sprite: "wisp-2", scale: 0.26 },
  { sprite: "puff-1", scale: 0.32 },
];
export const puffSeconds = 8;

/** Where the farmer and the pet stand (their feet's middle), and how big they are drawn: as they were painted. */
export const manager = { x: 1327 / sceneW, bottom: 898 / sceneH, scale: 0.73 } as const;
export const petSpot = { x: 1212 / sceneW, bottom: 918 / sceneH } as const;
/** Each pet's frames drawn sitting about as tall as the dog was painted. */
export const petScale: Readonly<Record<string, number>> = { dog: 0.59, ragdoll: 0.69, bluecat: 0.55 };

/** The farmer's pose at each hour: stretching at dawn, shading his eyes at noon, at ease at dusk, a lantern at night. */
export const managerPose: Readonly<Record<TitleScene, string>> = {
  morning: "manager-morning",
  day: "manager-day",
  evening: "manager-evening",
  night: "manager-night",
};

/** A pet's frame. */
export type PetFrame = "sit" | "tail" | "look" | "sleep";

/** Awake, a pet sits and swishes its tail a few times, then looks back at you for a moment; at night it sleeps. */
export const petRound: readonly { readonly frame: PetFrame; readonly ms: number }[] = [
  { frame: "sit", ms: 1400 },
  { frame: "tail", ms: 500 },
  { frame: "sit", ms: 500 },
  { frame: "tail", ms: 500 },
  { frame: "sit", ms: 2600 },
  { frame: "look", ms: 2200 },
  { frame: "sit", ms: 1800 },
  { frame: "tail", ms: 600 },
];

/** Each scene's light on what moves (CSS filters), and whether it has seeds blowing (none at night). */
export const light: Readonly<Record<TitleScene, { readonly sky: string; readonly ground: string; readonly smoke: string; readonly seeds: boolean }>> = {
  morning: {
    sky: "sepia(0.35) saturate(1.4) hue-rotate(-25deg) brightness(1.03)",
    ground: "sepia(0.15) brightness(1.02)",
    smoke: "brightness(1.05)",
    seeds: true,
  },
  day: { sky: "none", ground: "none", smoke: "brightness(1.1)", seeds: true },
  evening: {
    sky: "sepia(0.6) saturate(2.2) hue-rotate(-35deg) brightness(0.98)",
    ground: "sepia(0.45) saturate(1.3) hue-rotate(-12deg) brightness(0.88)",
    smoke: "sepia(0.4) saturate(1.4) hue-rotate(-20deg)",
    seeds: true,
  },
  night: {
    sky: "brightness(0.32) saturate(0.6) hue-rotate(25deg)",
    ground: "brightness(0.38) saturate(0.7) hue-rotate(20deg)",
    smoke: "brightness(0.55) saturate(0.6) hue-rotate(20deg)",
    seeds: false,
  },
};
