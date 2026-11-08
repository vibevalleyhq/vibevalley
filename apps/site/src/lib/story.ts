/** ax/ay anchor the sprite's feet (apps/web/public/pixel/sprites.json). */
export interface Art {
  src: string;
  w: number;
  h: number;
  ax: number;
  ay: number;
}

export type Pose = "side" | "side-1" | "side-2" | "up" | "read" | "work" | "tinker-1" | "tinker-2" | "hammer-1" | "hammer-2" | "cheer";
export const THINGS = ["prop-board", "machine-seeder", "prop-table", "prop-crates", "machine-windmill", "machine-beehive", "machine-tractor"] as const;
export const PLOTS = ["plot-empty", "plot-seeded", "plot-sprout", "plot-leafy", "plot-flowering", "plot-wheat"] as const;
export const BUBBLES = [
  "act-speaking_text",
  "act-thinking",
  "icon-seeds",
  "act-read_file",
  "act-search",
  "act-edit_file",
  "act-run_command",
  "mark-check",
] as const;
export const MARKS = ["coins-stack", "stamp-done"] as const;
export const FRONT = ["fg-grass", "fg-fern"] as const;
export type Thing = (typeof THINGS)[number];
export type PlotStage = (typeof PLOTS)[number];
export type Bubble = (typeof BUBBLES)[number];
export type StoryArt = Record<Pose | Thing | PlotStage | Bubble | (typeof MARKS)[number] | (typeof FRONT)[number], Art>;

/** The field: how wide and high, where things stand (their feet) and where the helper walks. */
export const FIELD = { w: 820, h: 132, stand: 96, path: 112 } as const;

/** Initial x in field pixels. */
export const START = 18;

/** Steps follow copy.how.steps order. */
export interface Place {
  /** Where the helper works (its feet on the path). */
  at: number;
  plot: number;
  thing: { name: Thing; x: number };
  /** The plot before the helper gets there, then as the work goes (the stage from each share of the work on). */
  stages: [[number, PlotStage], ...[number, PlotStage][]];
}

export const PLACES: readonly Place[] = [
  { at: 96, plot: 168, thing: { name: "prop-board", x: 96 }, stages: [[0, "plot-empty"]] },
  {
    at: 330,
    plot: 330,
    thing: { name: "machine-seeder", x: 270 },
    stages: [
      [0, "plot-empty"],
      [0.3, "plot-seeded"],
      [0.72, "plot-sprout"],
    ],
  },
  {
    at: 478,
    plot: 590,
    thing: { name: "prop-table", x: 528 },
    stages: [
      [0, "plot-sprout"],
      [0.35, "plot-leafy"],
      [0.75, "plot-flowering"],
    ],
  },
  {
    at: 712,
    plot: 712,
    thing: { name: "prop-crates", x: 776 },
    stages: [
      [0, "plot-flowering"],
      [0.15, "plot-wheat"],
    ],
  },
];

/** x is measured in the back layer's own scroll space. */
export const BACK: readonly { name: Thing; x: number }[] = [
  { name: "machine-windmill", x: 120 },
  { name: "machine-beehive", x: 300 },
  { name: "machine-tractor", x: 470 },
];

/** x is measured in the front layer's own scroll space. */
export const NEAR: readonly { name: (typeof FRONT)[number]; x: number }[] = [
  { name: "fg-grass", x: 40 },
  { name: "fg-fern", x: 300 },
  { name: "fg-grass", x: 560 },
  { name: "fg-fern", x: 860 },
  { name: "fg-grass", x: 1100 },
];

/** How fast each layer passes as the camera goes along, the field itself at 1. */
export const PACE = { sky: 0.08, hills: 0.3, back: 0.55, field: 1, near: 1.4 } as const;

export interface Moment {
  /** The step, 0 to 3. */
  place: number;
  /** Walking there, or at work. */
  working: boolean;
  /** How far along the work is, 0 to 1 (0 while walking). */
  work: number;
  /** Where the helper is. */
  x: number;
}

/** The story at p (0 to 1) along the scroll. */
export function momentAt(p: number): Moment {
  const q = Math.min(0.99999, Math.max(0, p)) * PLACES.length;
  const place = Math.floor(q);
  const local = q - place;
  const previous = PLACES[place - 1];
  const current = PLACES[place];
  if (!current || (place !== 0 && !previous)) throw new RangeError(`Invalid story place ${place}`);
  const from = previous ? previous.at : START;
  const to = current.at;
  if (local < 0.3) {
    const k = local / 0.3;
    const eased = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
    return { place, working: false, work: 0, x: from + (to - from) * eased };
  }
  return { place, working: true, work: (local - 0.3) / 0.7, x: to };
}

/** Stage thresholds are ascending; a finished place keeps its last stage. */
export function stageOf(i: number, now: Moment): PlotStage {
  const place = PLACES[i];
  if (!place) throw new RangeError(`Invalid story place ${i}`);
  const { stages } = place;
  if (now.place < i || (now.place === i && !now.working)) return stages[0][1];
  const work = now.place > i ? 1 : now.work;
  const stage = stages.findLast(([from]) => work >= from);
  if (!stage) throw new RangeError(`No stage for story place ${i} at work ${work}`);
  return stage[1];
}

/** Multiple poses play in alternating frames. */
export function workAt(place: number, work: number): { poses: [Pose, ...Pose[]]; bubble?: Bubble | undefined } {
  switch (place) {
    case 0:
      return work < 0.5 ? { poses: ["up"], bubble: work > 0.12 ? "act-speaking_text" : undefined } : { poses: ["read"], bubble: "act-thinking" };
    case 1:
      return work < 0.45 ? { poses: ["work"], bubble: work > 0.12 ? "icon-seeds" : undefined } : { poses: ["tinker-1", "tinker-2"], bubble: "icon-seeds" };
    case 2: {
      const tools: Bubble[] = ["act-read_file", "act-search", "act-edit_file", "act-run_command", "mark-check"];
      return { poses: ["hammer-1", "hammer-2"], bubble: tools[Math.min(tools.length - 1, Math.floor(work * tools.length))] };
    }
    default:
      return { poses: work < 0.2 ? ["up"] : ["cheer"] };
  }
}

/** The job the story grows, the same as the harvest list's: what its branch comes to. */
export const JOB = { commits: 3, files: 4, plus: 142, minus: 12, tests: 18 } as const;

export function branchAt(now: Moment) {
  const work = now.place === 2 ? (now.working ? now.work : 0) : now.place > 2 ? 1 : 0;
  const typed = Math.min(1, work / 0.85);
  return {
    forked: now.place > 1 || (now.place === 1 && now.working),
    commits: now.place > 2 ? JOB.commits : [0.25, 0.55, 0.85].filter((at) => work >= at).length,
    plus: Math.round(JOB.plus * typed),
    minus: Math.round(JOB.minus * typed),
    tests: work >= 0.6 ? Math.round(JOB.tests * Math.min(1, (work - 0.6) / 0.3)) : 0,
    merged: now.place === 3 && now.working && now.work >= 0.75,
  };
}
