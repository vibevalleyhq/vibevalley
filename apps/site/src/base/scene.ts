export type Scene = "morning" | "day" | "evening" | "night";
export const SCENES: readonly Scene[] = ["morning", "day", "evening", "night"];

/** Warm lantern fireflies drifting over the diorama at dusk and night. Fixed per scene. */
export function firefliesOf(scene: Scene) {
  const count = { morning: 0, day: 0, evening: 10, night: 26 }[scene];
  let seed = scene.length * 7919 + 17;
  const r = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  return Array.from({ length: count }, () => ({
    x: 24 + r() * 72,
    y: 42 + r() * 52,
    size: 4 + Math.floor(r() * 3),
    duration: 5 + r() * 6,
    delay: -r() * 8,
  }));
}
