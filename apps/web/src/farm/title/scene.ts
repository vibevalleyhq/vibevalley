// The title screen's scene: the farm at the hour it is, and the fireflies over its fields at
// dusk and night. `?tod=0.9` (as for the farm's canvas) picks another hour.

export type TitleScene = "morning" | "day" | "evening" | "night";

export const titleBackground = (scene: TitleScene) => `/pixel/title-${scene}.jpg`;

export function hourNow(search = typeof location === "undefined" ? "" : location.search, now = new Date()): number {
  const tod = Number(new URLSearchParams(search).get("tod"));
  if (Number.isFinite(tod) && tod > 0 && tod < 1) return tod * 24;
  return now.getHours() + now.getMinutes() / 60;
}

export function sceneAt(hour: number): TitleScene {
  if (hour >= 5 && hour < 9) return "morning";
  if (hour >= 9 && hour < 16) return "day";
  if (hour >= 16 && hour < 19.5) return "evening";
  return "night";
}

let opened: TitleScene | undefined;

/** The scene the page opened at: the title keeps it, and startup loads its picture. */
export const startScene = (): TitleScene => (opened ??= sceneAt(hourNow()));

/** Fixed per scene, so it does not jump: where it starts (percent of the scene), how big, how slow. */
export interface Mote {
  readonly x: number;
  readonly y: number;
  readonly size: number;
  readonly duration: number;
  readonly delay: number;
}

/** The same scene draws the same motes. */
const random = (seed: number) => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

const fireflies: Readonly<Record<TitleScene, number>> = { morning: 0, day: 0, evening: 10, night: 26 };

export function motesOf(scene: TitleScene): Mote[] {
  const r = random(scene.length * 7919 + 17);
  // The lower half, away from the menu's column.
  return Array.from({ length: fireflies[scene] }, () => ({
    x: 30 + r() * 68,
    y: 48 + r() * 48,
    size: 3 + Math.floor(r() + 0.5),
    duration: 5 + r() * 6,
    delay: -r() * 8,
  }));
}
