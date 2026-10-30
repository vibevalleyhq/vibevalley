// The village's named positions, read from the level, and where a helper stands.

import { navMap, type NavMap } from "@vibevalley/engine/nav";
import type { Crop, Session, SessionAction } from "@vibevalley/protocol";

import { add, type Box, inBox, type Level, type Point } from "./level";
import { yardPlaces } from "./places";
import { bedOfStation, isRipe } from "./plots";

export const plotW = 34;
export const plotH = 26;

export type Facing = "up" | "down" | "left" | "right";
export type PlotSpot = "front" | "left" | "right" | "back";

/** Around a plot, from its bottom-centre: where a helper stands to look on. */
const around: Record<PlotSpot, Point> = { front: { x: 0, y: 5 }, left: { x: -24, y: -10 }, right: { x: 24, y: -10 }, back: { x: 6, y: -29 } };

/** In a plot's soil, from its bottom-centre: where a helper stands to work it, the tool landing in the soil. */
const inBed: Record<PlotSpot, Point> = { front: { x: 0, y: -9 }, left: { x: -7, y: -11 }, right: { x: 7, y: -11 }, back: { x: 0, y: -13 } };

const facingAt: Record<PlotSpot, Facing> = { front: "up", back: "down", left: "right", right: "left" };

export interface Prop {
  readonly spot: string;
  readonly sprite: string;
  readonly at: Point;
  readonly box: Box;
}

export interface Goal {
  /** What the goal is, to tell when it changes: "plot:front", "library", "gate"… */
  readonly key: string;
  readonly at: Point;
  /** undefined keeps the way it walked in. */
  readonly facing?: Facing;
}

export type FxKind = "chimney" | "anvil" | "mast" | "pond";

/** What a helper works from the side (the anvil) is this far in front of where it stands. */
const reach = 15;

const facingOf = (v: unknown): Facing => (v === "down" || v === "left" || v === "right" ? v : "up");

export class VillageWorld {
  readonly plots: ReadonlyMap<number, Point>;
  readonly gate: Point;
  readonly queue: Point;
  readonly orchestrator: Point;
  readonly dog: Point;
  readonly lawn: readonly Point[];
  readonly lights: readonly { readonly at: Point; readonly r: number }[];
  readonly props: readonly Prop[];
  readonly fx: Readonly<Record<FxKind, readonly Box[]>>;
  /** Each yard place's clickable box, by YardPlace id. */
  readonly spotBoxes: ReadonlyMap<string, Box>;
  readonly places: ReadonlyMap<string, { readonly at: Point; readonly facing: Facing }>;
  private navMap: NavMap | undefined;

  readonly level: Level;
  constructor(level: Level) {
    this.level = level;
    this.plots = new Map(level.thingsOf("Plot").map((t) => [Number(t.field("index")), t.at]));
    this.gate = level.theThing("Gate").at;
    this.queue = level.theThing("Queue").at;
    this.orchestrator = level.theThing("Manager").at;
    this.dog = level.theThing("Dog").at;
    this.lawn = [...level.thingsOf("Rest")].toSorted((a, b) => Number(a.field("n")) - Number(b.field("n"))).map((t) => t.at);
    this.lights = level.thingsOf("Light").map((t) => ({ at: t.at, r: Number(t.field("r")) }));
    this.props = level.thingsOf("Prop").map((t) => ({ spot: String(t.field("spot")), sprite: String(t.field("sprite")), at: t.at, box: t.box }));
    const fxOf = (kind: FxKind) =>
      level
        .thingsOf("Fx")
        .filter((t) => t.field("kind") === kind)
        .map((t) => t.box);
    this.fx = { chimney: fxOf("chimney"), anvil: fxOf("anvil"), mast: fxOf("mast"), pond: fxOf("pond") };
    this.spotBoxes = new Map(
      yardPlaces.map((p) => {
        const thing = level.thingsOf("Prop").find((t) => t.field("spot") === p.id) ?? level.thingsOf("Area").find((t) => t.field("spot") === p.id);
        if (!thing) throw new Error(`village.ldtk: no Prop or Area for ${p.id}`);
        return [p.id, thing.box];
      }),
    );
    this.places = new Map(level.thingsOf("Place").map((t) => [String(t.field("place")), { at: t.at, facing: facingOf(t.field("facing")) }]));
  }

  get width() {
    return this.level.width;
  }

  get height() {
    return this.level.height;
  }

  /** A plot's bottom-centre point. */
  plotAt(index: number): Point {
    const at = this.plots.get(index);
    if (!at) throw new Error(`village.ldtk: no Plot ${index}`);
    return at;
  }

  plotBox(index: number): Box {
    const p = this.plotAt(index);
    return { x0: p.x - plotW / 2, y0: p.y - plotH + 2, x1: p.x + plotW / 2, y1: p.y };
  }

  queueSpot(n: number): Point {
    return { x: this.queue.x - n * 13, y: this.queue.y + (n % 2) * 4 };
  }

  /** The plots and the props' feet are left out of the level's ground: they are the game's, so they can move. */
  walkable(p: Point): boolean {
    return (
      this.level.ground1(p) &&
      !this.props.some((s) => inBox(p, { x0: s.box.x0, y0: s.box.y1 - 7, x1: s.box.x1, y1: s.box.y1 + 1 })) &&
      !Array.from({ length: 9 }, (_, i) => this.plotBox(i)).some((b) => inBox(p, b))
    );
  }

  /** Built on first use: a few milliseconds over the whole level. */
  get nav(): NavMap {
    this.navMap ??= navMap({ w: this.width + 16, h: this.height, cell: 2, clearance: 2, walkable: (p) => this.walkable(p) });
    return this.navMap;
  }

  goalOf(a: {
    here: boolean;
    station: number;
    queueIndex: number;
    calls: boolean;
    place: string;
    stroll: Stroll | undefined;
    pose: Pose;
    crowd: (key: string) => number;
  }): Goal {
    if (!a.here) return { key: "gate", at: this.gate };
    const bed = bedOfStation(a.station);
    if (!bed) return { key: `queue:${a.queueIndex}`, at: this.queueSpot(a.queueIndex) };
    const plot = this.plotAt(bed.index);
    if (a.calls) return { key: "plot:front", at: { x: plot.x, y: plot.y + around.front.y }, facing: "down" };
    const place = a.place !== "plot" ? this.places.get(a.place) : undefined;
    if (place) {
      const n = a.crowd(a.place);
      if (place.facing === "left" || place.facing === "right") return this.besideIt(a.place, place.at, place.facing, n);
      return { key: a.place, at: { x: place.at.x + (n % 2 !== 0 ? 1 : -1) * Math.ceil(n / 2) * 12, y: place.at.y + (n % 3) }, facing: place.facing };
    }
    const spot = a.stroll?.spot ?? "right";
    const rest = a.stroll?.rest ?? 0;
    if (spot === "rest") return { key: `rest:${rest}`, at: this.lawn[rest % this.lawn.length] ?? this.gate };
    if (a.pose === "work") return { key: `bed:${spot}`, at: add(plot, inBed[spot]), facing: "down" };
    return { key: `plot:${spot}`, at: add(plot, around[spot]), facing: facingAt[spot] };
  }

  /** The `n`th helper at what is worked from the side: the first at its spot, the second across it, the rest in front. */
  private besideIt(key: string, at: Point, facing: "left" | "right", n: number): Goal {
    const dir = facing === "right" ? 1 : -1;
    if (n === 0) return { key, at, facing };
    if (n === 1) return { key, at: { x: at.x + dir * reach * 2, y: at.y }, facing: facing === "right" ? "left" : "right" };
    return { key, at: { x: at.x + dir * reach + (n % 2 !== 0 ? -12 : 12) * Math.ceil((n - 1) / 2), y: at.y + 12 }, facing: "up" };
  }
}

export type Pose = "cheer" | "worry" | "idle" | "work" | "think";

const handsOn = new Set<SessionAction>(["edit_file", "run_command", "mcp", "other"]);

export function poseOf(s: Session, crop: Crop): Pose {
  if (isRipe(crop)) return "cheer";
  if (crop === "withered" || crop === "dry") return "worry";
  const phase = s.phase;
  if (phase._tag !== "working" || phase.doing.action === "none") return "idle";
  return handsOn.has(phase.doing.action) ? "work" : "think";
}

export function placeOfAction(action: SessionAction): string {
  switch (action) {
    case "read_file":
    case "search":
      return "library";
    case "run_command":
    case "mcp":
      return "workshop";
    case "web":
      return "mast";
    case "wait":
      return "bench";
    default:
      return "plot";
  }
}

export const plotCalls = (crop: Crop) => isRipe(crop) || crop === "withered" || crop === "dry";

export type StrollSpot = PlotSpot | "rest";

export function spotsFor(s: Session, crop: Crop, pose: Pose): readonly StrollSpot[] {
  if (isRipe(crop) || crop === "dry") return ["front"];
  if (crop === "withered") return ["front", "left", "right"];
  switch (s.phase._tag) {
    case "arriving":
      return ["right"];
    case "working":
      return pose === "work" ? ["front", "right", "left"] : ["left", "back", "right"];
    case "resting":
      return ["rest", "rest", "front", "back"];
    default:
      return ["front"];
  }
}

/** It sets off once it has wanted the new place for `settle` seconds and been where it is for `dwell`. */
export class Whereabouts {
  static readonly settle = 1.2;
  static readonly dwell = 2;

  place: string;
  since: number;
  want: string;
  wantSince: number;
  constructor(place: string, since: number, want: string, wantSince: number) {
    this.place = place;
    this.since = since;
    this.want = want;
    this.wantSince = wantSince;
  }

  moveOn(to: string, now: number, urgent = false) {
    if (to !== this.want) {
      this.want = to;
      this.wantSince = now;
    }
    if (this.want === this.place) return;
    if (urgent || (now - this.wantSince >= Whereabouts.settle && now - this.since >= Whereabouts.dwell)) {
      this.place = this.want;
      this.since = now;
    }
  }
}

export const restSpots = 5;

/** Seconds a helper lingers at a spot before strolling on, [min, max]. */
export const strollDwell = { working: [5, 11], other: [7, 15] } as const;

export interface Stroll {
  readonly spot: StrollSpot;
  readonly rest: number;
  readonly until: number;
}
