import sizes from "@game/title/sprites.json";

const SCENE = { w: 1536, h: 1024 } as const;

export type Scene = "morning" | "day" | "evening" | "night";
export const SCENES: readonly Scene[] = ["morning", "day", "evening", "night"];

export type SpriteName = keyof typeof sizes;

/** A sprite by its name, and its size as a share of the scene, so it scales with it. */
export function sprite(name: SpriteName, scale = 1) {
  const size = sizes[name];
  return { name, w: (size.w * scale) / SCENE.w, h: (size.h * scale) / SCENE.h };
}

/** A share of the scene as a CSS percentage. */
export const pct = (n: number) => `${(n * 100).toFixed(3)}%`;

/** Where the farmhouse chimney's mouth is, the same in every scene. */
export const CHIMNEY = { x: 1068 / SCENE.w, y: 330 / SCENE.h };

/** High in the sky, above the smoke: seconds to cross, and how far across each is when the page opens. */
export const CLOUDS: readonly { sprite: SpriteName; y: number; scale: number; duration: number; delay: number }[] = [
  { sprite: "cloud-big-1", y: -0.01, scale: 0.45, duration: 160, delay: -40 },
  { sprite: "cloud-wisp-1", y: 0.06, scale: 0.45, duration: 120, delay: -95 },
  { sprite: "cloud-mid-2", y: 0.015, scale: 0.38, duration: 190, delay: -150 },
];

/** Plants along the bottom, left and middle only (the farmer stands at the right): middle, scale, seconds a sway, degrees. */
export const PLANTS: readonly { sprite: SpriteName; x: number; scale: number; sway: number; lean: number }[] = [
  { sprite: "fern", x: 0.02, scale: 0.5, sway: 4.6, lean: 1.5 },
  { sprite: "grass-tall", x: 0.11, scale: 0.45, sway: 3.4, lean: 2.5 },
  { sprite: "dandelion-3", x: 0.2, scale: 0.42, sway: 3.9, lean: 3 },
  { sprite: "grass-daisy", x: 0.31, scale: 0.36, sway: 4.2, lean: 2 },
  { sprite: "dandelion-2", x: 0.47, scale: 0.36, sway: 3.6, lean: 3 },
  { sprite: "grass-yellow", x: 0.985, scale: 0.4, sway: 4, lean: 2 },
];

/** Seeds off the two dandelions, up and away to the right. */
export const SEEDS: readonly { sprite: SpriteName; from: number; duration: number; delay: number }[] = [
  { sprite: "seed-1", from: 0.2, duration: 16, delay: -2 },
  { sprite: "seed-2", from: 0.47, duration: 19, delay: -9 },
  { sprite: "seed-3", from: 0.2, duration: 22, delay: -15 },
  { sprite: "seed-4", from: 0.47, duration: 17, delay: -5 },
  { sprite: "seed-2", from: 0.2, duration: 25, delay: -20 },
];

/** Puffs out of the chimney one after another, close enough to read as one plume. */
export const PUFFS: readonly { sprite: SpriteName; scale: number }[] = [
  { sprite: "puff-1", scale: 0.3 },
  { sprite: "puff-2", scale: 0.26 },
  { sprite: "wisp-1", scale: 0.32 },
  { sprite: "puff-1", scale: 0.28 },
  { sprite: "puff-2", scale: 0.3 },
  { sprite: "wisp-2", scale: 0.26 },
  { sprite: "puff-1", scale: 0.32 },
];
export const PUFF_SECONDS = 8;

/** Where the farmer and the pet stand (their feet's middle) and how big: as they were painted. */
export const MANAGER = { x: 1327 / SCENE.w, bottom: 898 / SCENE.h, scale: 0.73 } as const;
export const PET = { x: 1212 / SCENE.w, bottom: 918 / SCENE.h, scale: 0.59 } as const;

export const managerOf = (scene: Scene) => sprite(`manager-${scene}`, MANAGER.scale);

export const DOG = {
  sit: sprite("dog-sit", PET.scale),
  tail: sprite("dog-tail", PET.scale),
  look: sprite("dog-look", PET.scale),
  sleep: sprite("dog-sleep", PET.scale),
};

/** A firefly over the fields: where it starts (percent of the scene), how big (px), how slow. Fixed per scene. */
export function firefliesOf(scene: Scene) {
  const count = { morning: 0, day: 0, evening: 10, night: 26 }[scene];
  let seed = scene.length * 7919 + 17;
  const r = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  return Array.from({ length: count }, () => ({ x: 30 + r() * 68, y: 48 + r() * 48, size: 3 + Math.floor(r() + 0.5), duration: 5 + r() * 6, delay: -r() * 8 }));
}

/** The plants in front of the helpers along the field's edge (the parade). */
export const FRONT: readonly SpriteName[] = ["grass-tall", "fern", "grass-daisy", "grass-low", "grass-yellow", "dandelion-1", "grass-dandelion"];

/** Every sprite the pages show, for images.ts to make their copies. */
export const SHOWN: readonly SpriteName[] = [
  ...new Set<SpriteName>([
    ...CLOUDS.map((c) => c.sprite),
    ...PUFFS.map((p) => p.sprite),
    ...PLANTS.map((p) => p.sprite),
    ...SEEDS.map((s) => s.sprite),
    ...SCENES.map((s) => managerOf(s).name),
    ...Object.values(DOG).map((d) => d.name),
    ...FRONT,
  ]),
];
