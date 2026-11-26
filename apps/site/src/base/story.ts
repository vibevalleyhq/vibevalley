export type Building = "b_notice_pavilion" | "b_study_courtyard" | "b_waterwheel_mill" | "b_warehouse";
export type Scenery = "b_bookshop" | "t_bridge_arch" | "p_boat";
export type PlotStage = "t_soil_bed" | "t_paddy_water" | "t_crop_sprout" | "t_crop_wheat";
export type FrontProp = "p_bamboo" | "p_willow" | "p_lantern_post";
export type BubbleIcon = "chat" | "spark" | "seedling" | "book" | "search" | "edit" | "terminal" | "check";

export type StoryArt = Record<"helper" | Building | Scenery | PlotStage | FrontProp, string>;

/** The diorama strip coordinate space: width, height, where structures stand, and the stone path line. */
export const FIELD = { w: 1200, h: 280, stand: 214, path: 244 } as const;

/** Initial x in stage coordinates. */
export const START = 44;

/** Steps follow copy.how.steps order. */
export interface Place {
  /** Where the helper works along the stone path. */
  at: number;
  plot: number;
  thing: { name: Building; x: number; width: number };
  /** The plot before the helper gets there, then as the work progresses. */
  stages: [[number, PlotStage], ...[number, PlotStage][]];
}

export const PLACES: readonly Place[] = [
  {
    at: 160,
    plot: 270,
    thing: { name: "b_notice_pavilion", x: 136, width: 132 },
    stages: [[0, "t_soil_bed"]],
  },
  {
    at: 470,
    plot: 470,
    thing: { name: "b_study_courtyard", x: 378, width: 146 },
    stages: [
      [0, "t_soil_bed"],
      [0.3, "t_paddy_water"],
      [0.72, "t_crop_sprout"],
    ],
  },
  {
    at: 760,
    plot: 870,
    thing: { name: "b_waterwheel_mill", x: 752, width: 144 },
    stages: [
      [0, "t_crop_sprout"],
      [0.45, "t_crop_wheat"],
    ],
  },
  {
    at: 1040,
    plot: 1040,
    thing: { name: "b_warehouse", x: 1126, width: 136 },
    stages: [
      [0, "t_crop_sprout"],
      [0.18, "t_crop_wheat"],
    ],
  },
];

/** Distant Jiangnan landmarks in the background parallax layer. */
export const BACK: readonly { name: Scenery; x: number; width: number }[] = [
  { name: "b_bookshop", x: 210, width: 110 },
  { name: "t_bridge_arch", x: 520, width: 112 },
  { name: "p_boat", x: 760, width: 88 },
];

/** Foreground Papertrails foliage brushing past the lower edge. */
export const NEAR: readonly { name: FrontProp; x: number; width: number }[] = [
  { name: "p_bamboo", x: 64, width: 58 },
  { name: "p_willow", x: 420, width: 92 },
  { name: "p_lantern_post", x: 740, width: 42 },
  { name: "p_bamboo", x: 1090, width: 58 },
  { name: "p_willow", x: 1420, width: 92 },
];

/** How fast each layer passes as the camera tracks the helper, with the field at 1. */
export const PACE = { sky: 0.08, hills: 0.28, back: 0.55, field: 1, near: 1.35 } as const;

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

/** Current vector action bubble for each stage of work. */
export function workAt(place: number, work: number): { bubble?: BubbleIcon | undefined } {
  switch (place) {
    case 0:
      return work < 0.5 ? { bubble: work > 0.12 ? "chat" : undefined } : { bubble: "spark" };
    case 1:
      return { bubble: work > 0.12 ? "seedling" : undefined };
    case 2: {
      const tools: BubbleIcon[] = ["book", "search", "edit", "terminal", "check"];
      return { bubble: tools[Math.min(tools.length - 1, Math.floor(work * tools.length))] };
    }
    default:
      return { bubble: work > 0.3 ? "check" : undefined };
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
