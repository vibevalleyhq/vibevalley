// The timing of a living scene: things that happen every so often, a little irregularly (a puff of smoke, a leaf,
// a ripple), and a wind that gusts and calms. Pure: the scene's clock in, decisions out.

/** Says when it is time again for each thing; the time is the scene's clock, in seconds. */
export interface Cadence {
  /**
   * True once every `seconds` or so for `key` (each wait is 70–130% of it, so nothing ticks like a metronome). The
   * first call only starts the count, at a random point in the first wait.
   */
  readonly due: (key: string, seconds: number, now: number) => boolean;
}

export function cadence(random: () => number = Math.random): Cadence {
  const next = new Map<string, number>();
  return {
    due: (key, seconds, now) => {
      const at = next.get(key);
      if (at === undefined) {
        next.set(key, now + random() * seconds);
        return false;
      }
      if (now < at) return false;
      next.set(key, now + seconds * (0.7 + random() * 0.6));
      return true;
    },
  };
}

/** How hard the wind blows at `t` seconds: 0.1 (calm) to 1 (a gust), changing slowly. */
export const gust = (t: number) => 0.55 + 0.45 * Math.sin(t * 0.21) * Math.sin(t * 0.067 + 1);
