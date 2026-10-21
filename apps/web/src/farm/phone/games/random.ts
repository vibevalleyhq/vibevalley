// The phone games' seeded generator: mulberry32 in 32-bit integer arithmetic, so a seed
// always deals the same pieces and obstacles.

/** A number in [0, 1) and the next seed. */
export function nextRandom(seed: number): [number, number] {
  const s = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(s ^ (s >>> 15), 1 | s);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}
