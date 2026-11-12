import { z } from "zod";

import { jsonString } from "@vibevalley/protocol/schema";

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Box {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

export const inBox = (p: Point, b: Box) => p.x >= b.x0 && p.x < b.x1 && p.y >= b.y0 && p.y < b.y1;

export const add = (a: Point, b: Point): Point => ({ x: a.x + b.x, y: a.y + b.y });

interface Thing {
  readonly at: Point;
  readonly box: Box;
  readonly field: (name: string) => unknown;
}

const LdtkEntitySchema = z.object({
  __identifier: z.string(),
  px: z.tuple([z.number(), z.number()]),
  width: z.number(),
  height: z.number(),
  __pivot: z.tuple([z.number(), z.number()]),
  fieldInstances: z.array(
    z.object({
      __identifier: z.string(),
      __value: z.unknown(),
    }),
  ),
});

const LdtkLayerSchema = z.object({
  __identifier: z.string(),
  __cWid: z.number(),
  __cHei: z.number(),
  __gridSize: z.number(),
  intGridCsv: z.array(z.number()),
  entityInstances: z.array(LdtkEntitySchema),
});
type LdtkLayer = z.output<typeof LdtkLayerSchema>;

const LdtkRepoSchema = z.object({
  levels: z.array(
    z.object({
      pxWid: z.number(),
      pxHei: z.number(),
      layerInstances: z.array(LdtkLayerSchema),
    }),
  ),
});

const decodeLdtkRepo = (text: string) => jsonString(LdtkRepoSchema).parse(text);

export class Level {
  readonly width: number;
  readonly height: number;
  private readonly ground: LdtkLayer;
  private readonly things: ReadonlyMap<string, readonly Thing[]>;
  private constructor(width: number, height: number, ground: LdtkLayer, things: ReadonlyMap<string, readonly Thing[]>) {
    this.width = width;
    this.height = height;
    this.ground = ground;
    this.things = things;
  }

  static parse(text: string): Level {
    const level = decodeLdtkRepo(text).levels[0];
    if (!level) throw new Error("village.ldtk: no level");
    const layer = (name: string) => {
      const l = level.layerInstances.find((x) => x.__identifier === name);
      if (!l) throw new Error(`village.ldtk: no layer ${name}`);
      return l;
    };
    const things = new Map<string, Thing[]>();
    for (const e of layer("Things").entityInstances) {
      const [x, y] = e.px;
      const x0 = x - e.__pivot[0] * e.width;
      const y0 = y - e.__pivot[1] * e.height;
      const fields = new Map(e.fieldInstances.map((f) => [f.__identifier, f.__value]));
      const thing: Thing = { at: { x, y }, box: { x0, y0, x1: x0 + e.width, y1: y0 + e.height }, field: (name) => fields.get(name) };
      const list = things.get(e.__identifier) ?? [];
      list.push(thing);
      things.set(e.__identifier, list);
    }
    return new Level(level.pxWid, level.pxHei, layer("Ground"), things);
  }

  /** In file order. */
  thingsOf(kind: string): readonly Thing[] {
    return this.things.get(kind) ?? [];
  }

  theThing(kind: string): Thing {
    const t = this.thingsOf(kind)[0];
    if (!t) throw new Error(`village.ldtk: no ${kind}`);
    return t;
  }

  /** Past the right edge the road goes on, as the edge column does. */
  ground1(p: Point): boolean {
    const g = this.ground;
    const cx = Math.min(g.__cWid - 1, Math.max(-1, Math.floor(p.x / g.__gridSize)));
    const cy = Math.floor(p.y / g.__gridSize);
    if (cx < 0 || cy < 0 || cy >= g.__cHei) return false;
    return g.intGridCsv[cy * g.__cWid + cx] === 1;
  }
}
