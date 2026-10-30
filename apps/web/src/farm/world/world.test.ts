import { describe, expect, test } from "vite-plus/test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { farmFraming } from "@vibevalley/protocol/host";
import { frameVillage, villageCutAcross, villageCutDown } from "./framing";
import { Level } from "./level";
import { beds, cropOfBed } from "./plots";
import { yardPlaces } from "./places";
import { SpriteAtlas, levelWidth } from "@/ui/pixel/atlas";
import { VillageWorld } from "./world";

const assets = join(import.meta.dirname, "../../../public");
const level = Level.parse(readFileSync(join(assets, "village.ldtk"), "utf8"));
const world = new VillageWorld(level);
const atlas = SpriteAtlas.parse(readFileSync(join(assets, "pixel/sprites.json"), "utf8"));

describe("the level", () => {
  test("is 384 by 256 with its nine plots, the places helpers walk to and the yard's spots", () => {
    expect([world.width, world.height]).toEqual([384, 256]);
    expect(farmFraming.picture).toEqual({ w: world.width, h: world.height });
    expect([...world.plots.keys()].toSorted((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    expect(beds.map((b) => world.plotAt(b.index))).toHaveLength(9);
    expect(level.thingsOf("Place")).toHaveLength(4);
    expect(world.places.has("library")).toBe(true);
    expect(world.lawn).toHaveLength(5);
    expect(world.lights).toHaveLength(6);
    expect(world.props).toHaveLength(6);
    expect(level.thingsOf("Area")).toHaveLength(3);
    expect([...world.spotBoxes.keys()]).toEqual(yardPlaces.map((p) => p.id));
    expect(Object.values(world.fx).flat()).toHaveLength(6);
  });

  test("the ground is walkable on the road, not inside a plot; a helper finds its way from the gate to every plot", () => {
    expect(world.walkable(world.gate)).toBe(true);
    const plot = world.plotAt(0);
    expect(world.walkable({ x: plot.x, y: plot.y - 10 })).toBe(false);
    for (const b of beds) {
      const route = world.nav.route(world.gate, world.plotAt(b.index));
      expect(route.length).toBeGreaterThanOrEqual(2);
    }
  });

  test("a helper stands in front of a plot that calls, at the gate when away, in the queue without a bed", () => {
    const base = { here: true, station: 0, queueIndex: 0, calls: false, place: "plot", stroll: undefined, pose: "idle" as const, crowd: () => 0 };
    expect(world.goalOf({ ...base, here: false }).key).toBe("gate");
    expect(world.goalOf({ ...base, station: -1, queueIndex: 2 }).at).toEqual(world.queueSpot(2));
    expect(world.goalOf({ ...base, calls: true })).toMatchObject({ key: "plot:front", facing: "down" });
    expect(world.goalOf({ ...base, place: "library" }).key).toBe("library");
  });
});

describe("the atlas", () => {
  test("the map is the level: 384 art pixels wide, drawn twice as dense", () => {
    expect(atlas.density).toBe(2);
    expect(atlas.get("map").w).toBe(levelWidth);
  });

  test("every sprite has its picture beside the manifest, and every crop has its plot", () => {
    const missing = [...atlas.names].filter((n) => !existsSync(join(assets, `pixel/${n}.png`)));
    expect(missing).toEqual([]);
    for (const crop of ["empty", "seeded", "sprout", "leafy", "flowering", "wheat", "carrot", "withered", "weeds", "dry", "harvested", "locked"]) {
      expect(atlas.has(`plot-${crop}`)).toBe(true);
    }
  });

  test("a variant falls back to the plainer sprite; the anchor is the attention pixel's bottom", () => {
    expect(atlas.first(["nope-such-sprite", "icon-board"]).name).toBe("icon-board");
    expect(atlas.has("nope-such-sprite")).toBe(false);
    const s = atlas.get("plot-empty");
    expect(atlas.anchorOf("plot-empty")).toEqual({ x: s.ax / s.w, y: (s.ay + 0.5) / s.h });
  });
});

describe("the plots", () => {
  const view = { level: { level: 6, xp: 0, need: 60 }, plots: { s1: { crop: "leafy" as const } }, achievements: [] };
  const session = { id: "s1", issue: "i1", play: { station: 2 } } as never;
  test("keyed by the session; a bed shows its session's crop, a sprout before the view has it, cleared beds flower", () => {
    expect(cropOfBed(beds[2]!, [session], view as never)).toBe("leafy");
    expect(cropOfBed(beds[2]!, [{ ...(session as object), id: "s2" } as never], view as never)).toBe("sprout");
    expect(cropOfBed(beds[0]!, [session], view as never)).toBe("empty");
    expect(cropOfBed(beds[6]!, [], view as never)).toBe("flowering");
    expect(cropOfBed(beds[7]!, [], view as never)).toBe("locked");
  });
});

describe("the framing", () => {
  const village = { w: 384, h: 256 };
  test("a window of the village's own shape holds it whole; a 16:10 one is covered one scale up", () => {
    expect(frameVillage({ w: 1152, h: 768 }, village)).toEqual({ scale: 3, box: { x: 0, y: 0, w: 1152, h: 768 }, shown: { x: 0, y: 0, w: 1152, h: 768 } });
    const f = frameVillage({ w: 1440, h: 900 }, village);
    expect(f.scale).toBe(4);
    expect(f.box).toEqual({ x: -48, y: -62, w: 1536, h: 1024 });
    expect(f.shown).toEqual({ x: 0, y: 0, w: 1440, h: 900 });
  });

  test("a window that would lose too much keeps a smaller scale and bars; cut on one side, bars on the other", () => {
    expect(frameVillage({ w: 1280, h: 800 }, village).box).toEqual({ x: 64, y: 16, w: 1152, h: 768 });
    const f = frameVillage({ w: 1100, h: 900 }, village);
    expect(f.box).toEqual({ x: -26, y: 66, w: 1152, h: 768 });
    expect(f.shown).toEqual({ x: 0, y: 66, w: 1100, h: 768 });
    expect(frameVillage({ w: 390, h: 844 }, village).scale).toBe(1);
  });

  test("never more is cut than the limits", () => {
    for (let w = 320; w <= 2600; w += 37) {
      for (let h = 300; h <= 1600; h += 29) {
        const f = frameVillage({ w, h }, village);
        if (f.scale === 1) continue;
        expect(-f.box.x).toBeLessThanOrEqual(f.box.w * villageCutAcross + 0.5);
        expect(-f.box.y).toBeLessThanOrEqual(f.box.h * villageCutDown + 0.5);
      }
    }
  });
});
