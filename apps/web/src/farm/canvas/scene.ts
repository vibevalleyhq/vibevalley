// The village on a Pixi stage: the map, the plots, the helpers walking between their plot and the
// buildings, the orchestrator and the pet, the effects over the plots, and the light: the sky by the time of day, lit on
// every pixel by the way it faces, the lamps and the helpers' lanterns after dark, shadows away from the sun; and the
// yard's own life (life.ts). What it shows comes from the server's folded state; the scene only adds what moves with
// the clock, and keeps only that (walkers, animation clocks, particles) in its own objects.

import {
  flatLight,
  frameAt,
  glowTexture,
  leanToPointer,
  pixelLighting,
  pixelStage,
  shadowTexture,
  skyAt,
  Walker,
  type Facing,
  type Lighting,
  type PixelStage,
  type PointLight,
  type Sky,
} from "@vibevalley/engine/pixi";
import type { Agent, Crop, Session, StateFrame } from "@vibevalley/protocol";
import { ColorMatrixFilter, Container, Graphics, Sprite, Texture } from "pixi.js";
import { castPrefix } from "../../rules/cast";
import { playSound } from "../sound";
import { clock, farmState, type BedFx } from "../store";
import { orchestratorLooks, orchestratorSprite } from "../kit/looks";
import { frameVillage } from "../world/framing";
import { villageHitAt, type VillageHit } from "../world/hits";
import type { Box, Point } from "../world/level";
import type { Village } from "../world/load";
import { bedOfStation, beds, cropOfBed, isRipe, plotKey, stationOfSession, type Bed } from "../world/plots";
import {
  placeOfAction,
  plotCalls,
  plotH,
  plotW,
  poseOf,
  restSpots,
  spotsFor,
  strollDwell,
  Whereabouts,
  type Goal,
  type Pose,
  type Stroll,
} from "../world/world";
import { villageDog } from "./dog";
import { plotFx } from "./fx";
import { villageLife, type Box as LifeBox, type Place } from "./life";
import { loadPictures } from "./pictures";
import { prefsNow } from "../../data/prefs";

/** Art pixels a second, and frames of the walk cycle a second. */
const walkSpeed = 42;
const walkFps = 8;
/** The plants in front of the camera lean this many art pixels towards the pointer; the yard itself stays still. */
const nearLean = 3;
/** Helpers fade out at the gate once they have left, and are gone after this long. */
const fadeS = 0.8;
const goneS = 3.6;
/** Helpers light their lanterns once it is this dark (night 0..1). */
const lanternDark = 0.35;
const lampColor = 0xffc46e;
const lanternColor = 0xffd28c;
/** Seconds between deciding where helpers want to be, and where on their plot they stroll. */
const whereTick = 0.3;
const strollTick = 0.6;
const background = "#2b3320";

/** What helpers do at each building, frame by frame, and how fast. */
const placePose: Record<Place, { frames: readonly string[]; fps: number }> = {
  bench: { frames: ["sit"], fps: 1 },
  library: { frames: ["read"], fps: 1 },
  workshop: { frames: ["hammer-1", "hammer-2"], fps: 3 },
  mast: { frames: ["tinker-1", "tinker-2"], fps: 1.5 },
};
const atBuilding = (key: string): key is Place => Object.hasOwn(placePose, key);

/** A hop, pixel by pixel, over this many seconds: a clicked helper. */
const hop = [2, 4, 5, 4, 2, 1] as const;
const hopS = 0.3;

const shadowH = 4;
const contactAlpha = 0.5;

const depth = (y: number) => Math.round(y * 10);

export interface SceneInput {
  readonly frame: StateFrame | undefined;
  readonly agents: ReadonlyMap<string, Agent>;
}

export interface SceneEvents {
  /** A plot was clicked, or the helper working it. */
  readonly onPlot: (bed: Bed) => void;
  /** A thing in the yard was clicked (a YardPlace id). */
  readonly onSpot: (spot: string) => void;
  /** What the pointer is over changed: the bed and the yard place, for the store. */
  readonly onHover: (bed: number | null, spot: string | null) => void;
}

export interface Scene {
  readonly stage: PixelStage;
  /** Where a helper's feet are now, art pixels. */
  readonly helperAt: (sessionId: string) => Point | undefined;
  readonly destroy: () => void;
}

interface Footing {
  readonly contact: Sprite;
  readonly cast: Sprite;
}

interface Actor {
  readonly node: Container;
  readonly body: Sprite;
  readonly footing: Footing;
  readonly lantern: Container;
  readonly walker: Walker;
  look: string;
  goal: Goal;
  bed?: Bed;
  station: number;
  leftAt?: number;
  goneFor: number;
  hopAt: number;
  where?: Whereabouts;
  stroll?: Stroll;
}

const toLifeBox = (b: Box): LifeBox => [b.x0, b.y0, b.x1, b.y1];

/**
 * Draws `village` into `host` and keeps it moving. `input` is read every frame (the latest frame and the profiles);
 * `lit`: the per-pixel light, with normal maps (off, the sky still tints the picture).
 */
export async function startScene(host: HTMLElement, village: Village, input: () => SceneInput, on: SceneEvents, lit = true): Promise<Scene> {
  const { world: v, atlas } = village;
  const [pics, stage] = await Promise.all([
    loadPictures(atlas, lit),
    pixelStage({
      host,
      w: v.width,
      h: v.height,
      background,
      density: atlas.density,
      frame: (box) => {
        const f = frameVillage(box, { w: v.width, h: v.height });
        return { scale: f.scale, x: f.box.x, y: f.box.y };
      },
    }),
  ]);
  const { has, texture } = pics;
  const { app, world } = stage;
  const pointer = leanToPointer(stage);

  let lighting: Lighting | undefined;
  if (lit) {
    try {
      lighting = pixelLighting(stage, { normalsOf: pics.normalsOf });
    } catch {
      lighting = undefined;
    }
  }
  // What shines by itself (lamp halos, lanterns, fireflies) goes over the lit world, added; marks over that, as painted.
  const glows = stage.layer(1);
  const marks = stage.layer(1);
  const life = villageLife(
    { world, glows, marks },
    {
      width: v.width,
      dog: v.dog,
      fx: { chimney: v.fx.chimney.map(toLifeBox), anvil: v.fx.anvil.map(toLifeBox), mast: v.fx.mast.map(toLifeBox), pond: v.fx.pond.map(toLifeBox) },
      workshop: toLifeBox(v.spotBoxes.get("runtimes") ?? { x0: 0, y0: 0, x1: 0, y1: 0 }),
      places: {
        bench: v.places.get("bench")?.at,
        library: v.places.get("library")?.at,
        workshop: v.places.get("workshop")?.at,
        mast: v.places.get("mast")?.at,
      },
      has,
      texture,
      mapColor: pics.mapColor,
    },
  );

  const shadows = new Map<string, Texture>();
  const groundShadow = (w: number, h: number) => {
    const key = `${w}x${h}`;
    const pic = shadows.get(key) ?? shadowTexture(w, h);
    shadows.set(key, pic);
    const s = new Sprite(pic);
    s.anchor.set(0.5);
    return s;
  };
  const footing = (w: number): Footing => ({ contact: groundShadow(w, shadowH), cast: groundShadow(w + 4, shadowH) });
  const lanternGlow = glowTexture(9, lampColor, 0.5);

  const map = new Sprite(texture("map"));
  map.zIndex = -1_000_000;
  world.addChild(map);

  const plots = beds.map((bed) => {
    const at = v.plotAt(bed.index);
    const sprite = new Sprite(Texture.EMPTY);
    sprite.position.set(at.x, at.y);
    sprite.zIndex = depth(at.y - plotH);
    const ring = new Graphics().rect(at.x - plotW / 2 - 1, at.y - plotH - 4, plotW + 2, plotH + 5).stroke({ width: 1, color: 0xffe9a0, alignment: 1 });
    ring.zIndex = sprite.zIndex + 5;
    ring.visible = false;
    world.addChild(sprite, ring);
    return { bed, sprite, ring, shown: "", ripe: false };
  });

  const orchestrator = new Sprite(texture("manager"));
  stand(orchestrator, "manager");
  orchestrator.position.set(v.orchestrator.x, v.orchestrator.y);
  orchestrator.zIndex = depth(v.orchestrator.y);
  const dog = new Sprite(texture("dog-sleep"));
  stand(dog, "dog-sleep");
  dog.position.set(v.dog.x, v.dog.y);
  dog.zIndex = depth(v.dog.y);
  const pup = villageDog();
  const grounded = [
    { at: v.orchestrator, footing: footing(14) },
    { at: v.dog, footing: footing(16) },
  ];
  for (const { at, footing: f } of grounded) {
    f.cast.zIndex = depth(at.y) - 6;
    f.contact.zIndex = depth(at.y) - 5;
    world.addChild(f.cast, f.contact);
  }
  world.addChild(orchestrator, dog);

  const props = v.props.flatMap((p) => {
    if (!has(p.sprite)) return [];
    const s = new Sprite(texture(p.sprite));
    stand(s, p.sprite);
    s.position.set(p.at.x, p.at.y);
    s.zIndex = depth(p.at.y);
    const foot = groundShadow(Math.max(10, Math.round(s.width * 0.9)), shadowH + 1);
    foot.position.set(p.at.x, p.at.y - 1);
    foot.alpha = contactAlpha;
    foot.zIndex = depth(p.at.y) - 5;
    world.addChild(s, foot);
    return [{ spot: p.spot, sprite: s, y: p.at.y }];
  });

  const lamps = v.lights.map((l) => {
    const s = new Sprite(glowTexture(Math.round(l.r * 0.8), lampColor));
    s.anchor.set(0.5);
    s.position.set(l.at.x, l.at.y);
    s.blendMode = "add";
    glows.addChild(s);
    return s;
  });

  // In front of the camera: plants framing the view, leaning with the pointer.
  const near = new Container();
  stage.layer(1).addChild(near);
  const plant = (name: string, x: number, y: number, ax: number, ay: number) => {
    if (!has(name)) return;
    const s = new Sprite(texture(name));
    s.anchor.set(ax, ay);
    s.position.set(x, y);
    near.addChild(s);
  };
  plant("fg-branch-left", -20, -30, 0, 0);
  plant("fg-branch-right", v.width + 20, -32, 1, 0);
  plant("fg-bush-left", -30, v.height + 26, 0, 1);
  plant("fg-bush-right", v.width + 34, v.height + 32, 1, 1);
  plant("fg-grass", v.width * 0.34, v.height + 16, 0.5, 1);
  plant("fg-fern", v.width * 0.6, v.height + 24, 0.5, 1);

  const actors = new Map<string, Actor>();
  const fx = plotFx(world, texture, (bed) => v.plotAt(bed));
  let t = 0;
  let whereAt = 0;
  let strollAt = 0;

  // ── Pointer: what is under it lights up; a press dips a plot; a click acts. ──
  let over: VillageHit | undefined;
  let downOn: VillageHit | undefined;
  let pointerAt: Point | undefined;
  const hitAt = (p: Point): VillageHit | undefined => {
    const sessions = new Map<string, Box>();
    for (const [id, a] of actors) {
      if (a.leftAt !== undefined) continue;
      const b = a.body.getBounds();
      // Bounds are in the stage's view; the world sits at the camera's offset.
      sessions.set(id, { x0: b.x - world.x, y0: b.y - world.y, x1: b.x + b.width - world.x, y1: b.y + b.height - world.y });
    }
    const db = dog.getBounds();
    return villageHitAt(
      {
        sessions,
        dog: { x0: db.x - world.x, y0: db.y - world.y, x1: db.x + db.width - world.x, y1: db.y + db.height - world.y },
        spots: v.spotBoxes,
        plots: new Map(beds.map((b) => [b.index, v.plotBox(b.index)])),
      },
      p,
    );
  };
  const bedOfHit = (hit: VillageHit | undefined) => (hit?.kind === "plot" ? hit.bed : hit?.kind === "session" ? actors.get(hit.id)?.bed?.index : undefined);
  const sameHit = (a: VillageHit | undefined, b: VillageHit | undefined) => JSON.stringify(a) === JSON.stringify(b);
  const setHover = (hit: VillageHit | undefined) => {
    if (sameHit(hit, over)) return;
    if (over?.kind === "dog") {
      pup.point(false);
      pup.press(false);
    }
    over = hit;
    if (hit?.kind === "dog") pup.point(true);
    on.onHover(bedOfHit(hit) ?? null, hit?.kind === "spot" ? hit.spot : null);
  };
  const canvas = app.canvas;
  const local = (e: PointerEvent) => stage.fromScreen({ x: e.offsetX, y: e.offsetY });
  let pressing = false;
  const onMove = (e: PointerEvent) => {
    pointerAt = local(e);
    setHover(hitAt(pointerAt));
  };
  const onDown = (e: PointerEvent) => {
    pointerAt = local(e);
    const hit = hitAt(pointerAt);
    setHover(hit);
    downOn = hit;
    pressing = bedOfHit(hit) !== undefined;
    if (hit?.kind === "dog") pup.press(true);
  };
  const onUp = (e: PointerEvent) => {
    const p = local(e);
    const hit = hitAt(p);
    const down = downOn;
    downOn = undefined;
    pressing = false;
    if (hit?.kind === "dog") pup.press(false);
    if (sameHit(hit, down)) tap(hit, p);
    if (e.pointerType === "touch") onLeave();
  };
  const onLeave = () => {
    pointerAt = undefined;
    setHover(undefined);
  };
  const tap = (hit: VillageHit | undefined, p: Point) => {
    switch (hit?.kind) {
      case "plot": {
        const bed = beds[hit.bed];
        if (bed) {
          fx.pressedAt.set(bed.index, fx.clock());
          on.onPlot(bed);
        }
        return;
      }
      case "session": {
        const actor = actors.get(hit.id);
        if (!actor) return;
        actor.hopAt = t;
        if (actor.bed) on.onPlot(actor.bed);
        return;
      }
      case "spot":
        return on.onSpot(hit.spot);
      case "dog":
        return petDog();
      case undefined:
        return life.poke(p.x, p.y);
    }
  };
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointerleave", onLeave);
  canvas.addEventListener("pointercancel", () => {
    downOn = undefined;
    pressing = false;
    pup.press(false);
  });

  const petDog = () => {
    const trick = pup.pet(t);
    const cat = prefsNow().pet !== "dog";
    life.heart(v.dog.x + 3, v.dog.y - 16);
    switch (trick) {
      case "wake":
      case "wag":
        return playSound(cat ? "purr" : "pant");
      case "bark":
        return playSound(cat ? "meow" : "woof");
      case "jump":
        return playSound(cat ? "mew" : "yip");
      case "belly":
        life.heart(v.dog.x - 4, v.dog.y - 12);
        life.heart(v.dog.x + 8, v.dog.y - 10);
        return playSound(cat ? "purr" : "pant");
    }
  };

  const makeActor = (look: string, goal: Goal): Actor => {
    const node = new Container();
    const under = footing(12);
    const body = new Sprite(texture(`${look}-down`));
    stand(body, `${look}-down`);
    node.addChild(under.cast, under.contact, body);
    const lantern = new Container();
    const halo = new Sprite(lanternGlow);
    halo.anchor.set(0.5);
    halo.position.set(1, 1.5);
    const flame = new Graphics().rect(0, 0, 2, 3).fill(0xffb347).rect(0, 1, 2, 1).fill(0xfff1c2);
    halo.blendMode = "add";
    flame.blendMode = "add";
    lantern.addChild(halo, flame);
    lantern.visible = false;
    glows.addChild(lantern);
    // Everyone walks in from the gate.
    const walker = new Walker(v.gate, walkSpeed, (a, b) => v.nav.route(a, b));
    walker.go(goal.at);
    world.addChild(node);
    return { node, body, footing: under, lantern, walker, look, goal, station: -1, goneFor: 0, hopAt: -10 };
  };

  const placeFor = (s: Session, crop: Crop) => {
    if (plotCalls(crop)) return "plot";
    return s.phase._tag === "working" ? placeOfAction(s.phase.doing.action) : "plot";
  };

  const strollOn = (actor: Actor, s: Session, crop: Crop, pose: Pose) => {
    const allowed = spotsFor(s, crop, pose);
    const current = actor.stroll;
    if (current && allowed.includes(current.spot) && t < current.until) return;
    // The lawn has several places, so "rest" may repeat.
    const options = current && allowed.length > 1 ? allowed.filter((x) => x !== current.spot || x === "rest") : allowed;
    const spot = options[Math.floor(Math.random() * options.length)] ?? "front";
    const [lo, hi] = strollDwell[s.phase._tag === "working" ? "working" : "other"];
    actor.stroll = { spot, rest: Math.floor(Math.random() * restSpots), until: t + lo + Math.random() * (hi - lo) };
  };

  const draw = (actor: Actor, pose: Pose | "idle", station: number) => {
    const { walker, body, node, look, goal } = actor;
    node.position.set(Math.round(walker.x), Math.round(walker.y));
    node.zIndex = depth(walker.y);
    let name: string;
    let flip = false;
    let lift = 0;
    let grow = 0;
    if (walker.walking) {
      const dir = sideOf(walker.facing);
      const cycle = [`${dir}-1`, dir, `${dir}-2`, dir];
      name = `${look}-${cycle[frameAt(t, 4, walkFps)]}`;
      flip = walker.facing === "left";
    } else if (atBuilding(goal.key) && has(`${look}-${placePose[goal.key].frames[0]}`)) {
      const { frames, fps } = placePose[goal.key];
      name = `${look}-${frames[frameAt(t, frames.length, fps)] ?? frames[0]}`;
      flip = goal.facing === "left";
      if (frames.length === 1) grow = frameAt(t + station * 0.3, 2, 0.8);
    } else {
      const facing = goal.facing ?? walker.facing;
      switch (pose) {
        case "work":
          name = atBuilding(goal.key) ? `${look}-${sideOf(facing)}` : `${look}-work`;
          flip = atBuilding(goal.key) && facing === "left";
          grow = -frameAt(t, 2, 3);
          break;
        case "cheer":
          name = `${look}-cheer`;
          lift = frameAt(t, 2, 2) * 2;
          break;
        case "worry":
          name = `${look}-worry`;
          break;
        default:
          name = `${look}-${sideOf(facing)}`;
          flip = facing === "left";
          grow = frameAt(t + station * 0.3, 2, 0.8);
      }
    }
    const since = t - actor.hopAt;
    if (since < hopS) lift += hop[Math.min(hop.length - 1, Math.floor((since / hopS) * hop.length))] ?? 0;
    stand(body, has(name) ? name : `${look}-down`);
    body.scale.x = flip ? -1 : 1;
    rise(body, grow);
    body.y = -lift;
  };

  const tick = () => {
    const dt = Math.min(0.1, app.ticker.deltaMS / 1000);
    t += dt;
    clock.advance(dt);
    const { frame, agents } = input();
    const store = farmState();
    if (!frame) return;
    const { state, view } = frame;
    const present = new Map(state.sessions.map((s) => [s.id, s]));
    // What is under a still pointer is found again as things move under it.
    if (pointerAt && !downOn) setHover(hitAt(pointerAt));
    const hovered = store.hoverBed;
    const cropOf = (s: Session): Crop => view.plots[plotKey(s)]?.crop ?? "sprout";

    for (const p of plots) {
      const { bed } = p;
      const leaving =
        bed.unlockLevel === undefined &&
        !state.sessions.some((s) => stationOfSession(s) === bed.station) &&
        [...actors.values()].some((a) => a.leftAt !== undefined && a.station === bed.station);
      const crop = cropOfBed(bed, state.sessions, view, leaving);
      p.ripe = bed.unlockLevel === undefined && isRipe(crop);
      const name = `plot-${crop}`;
      if (p.shown !== name) {
        p.shown = name;
        stand(p.sprite, name);
      }
      const hot = hovered === bed.index;
      p.ring.visible = hot;
      const pressed = (pressing && hot) || fx.clock() - (fx.pressedAt.get(bed.index) ?? -1) < 0.15;
      p.sprite.y = v.plotAt(bed.index).y + (pressed ? 1 : hot ? -1 : 0);
    }

    const spot = store.hoverSpot;
    for (const p of props) {
      glow(p.sprite, p.spot === spot);
      p.sprite.y = p.y - (p.spot === spot ? 1 : 0);
    }
    glow(orchestrator, spot === "manager");

    const moveOn = t - whereAt >= whereTick;
    if (moveOn) whereAt = t;
    const stroll = t - strollAt >= strollTick;
    if (stroll) strollAt = t;

    const counts = new Map<string, number>();
    const crowd = (key: string) => counts.get(key) ?? 0;
    let queued = 0;
    for (const s of [...state.sessions].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
      const station = stationOfSession(s);
      const crop = cropOf(s);
      const pose = poseOf(s, crop);
      const calls = plotCalls(crop);
      const queueIndex = station < 0 ? queued++ : 0;
      const look = castPrefix(agents.get(s.agent)?.look, s.agent, has);
      let actor = actors.get(s.id);
      if (actor && actor.leftAt !== undefined) {
        actor.leftAt = undefined;
        actor.goneFor = 0;
      }
      if (station >= 0 && actor) {
        actor.where ??= new Whereabouts("plot", t, placeFor(s, crop), t);
        if (moveOn) actor.where.moveOn(placeFor(s, crop), t, calls);
        if (stroll) strollOn(actor, s, crop, pose);
      } else if (actor) {
        actor.where = undefined;
        actor.stroll = undefined;
      }
      const goal = v.goalOf({ here: true, station, queueIndex, calls, place: actor?.where?.place ?? "plot", stroll: actor?.stroll, pose, crowd });
      counts.set(goal.key, crowd(goal.key) + 1);
      if (!actor) {
        actor = makeActor(look, goal);
        actors.set(s.id, actor);
        if (station >= 0) actor.where = new Whereabouts("plot", t, placeFor(s, crop), t);
      }
      actor.look = look;
      actor.station = station;
      actor.bed = bedOfStation(station);
      actor.goal = goal;
      actor.walker.go(goal.at);
      actor.walker.step(dt);
      draw(actor, pose, station);
    }
    for (const [id, actor] of [...actors]) {
      if (present.has(id)) continue;
      actor.leftAt ??= t;
      if (t - actor.leftAt >= goneS) {
        actor.node.destroy({ children: true });
        actor.lantern.destroy({ children: true });
        actors.delete(id);
        continue;
      }
      actor.goal = { key: "gate", at: v.gate };
      actor.walker.go(v.gate);
      actor.walker.step(dt);
      draw(actor, "idle", actor.station);
      if (!actor.walker.walking) actor.goneFor += dt;
    }
    for (const a of actors.values()) a.node.alpha = Math.max(0, 1 - a.goneFor / fadeS);

    const bedOfSession = (id: string) => {
      const a = actors.get(id);
      if (a?.bed) return a.bed.index;
      const s = present.get(id);
      return s ? bedOfStation(stationOfSession(s))?.index : undefined;
    };
    fx.update(dt, store.bedFx as readonly BedFx[], store.rewards, bedOfSession);

    // The orchestrator talks and listens; the pet wakes up for a call.
    const mood = state.orchestrator;
    const chosen = prefsNow().orchestratorLook;
    const lookId = chosen !== "farmer" && orchestratorLooks.some((l) => l.id === chosen) && has(`manager-${chosen}`) ? chosen : "farmer";
    const base = lookId === "farmer" ? "manager" : `manager-${lookId}`;
    const orchestratorPose =
      mood === "speaking" ? orchestratorSprite(lookId, "-talk", has) : mood === "listening" ? orchestratorSprite(lookId, "-listen", has) : base;
    stand(orchestrator, has(orchestratorPose) ? orchestratorPose : base);
    rise(orchestrator, mood === "speaking" ? frameAt(t, 2, 4) : frameAt(t, 2, 0.6));
    const dogLook = pup.look(t, state.call === "live");
    const awake = dogLook.picture !== "dog-sleep";
    const pet = prefsNow().pet;
    const petPicture = pet === "dog" ? dogLook.picture : dogLook.picture.replace("dog-", `${pet}-`);
    stand(dog, has(petPicture) ? petPicture : dogLook.picture);
    dog.y = v.dog.y - dogLook.lift;
    rise(dog, dogLook.grow);

    // Light.
    const sky = skyAt(clock.day().tod);
    const { night } = sky;
    const lights: PointLight[] = [];
    v.lights.forEach((l, i) => {
      const flicker = 0.9 + 0.1 * frameAt(t + i * 0.37, 2, 3);
      const halo = lamps[i];
      if (halo) halo.alpha = night * flicker;
      lights.push({ x: l.at.x, y: l.at.y, z: 14, radius: l.r * 2.6, color: lampColor, intensity: 1.3 * night * flicker });
    });
    const lean = shadowLean(sky);
    for (const { at, footing: f } of grounded) fall(f, at, lean, 1);
    for (const a of actors.values()) {
      fall(a.footing, { x: 0, y: 0 }, lean, a.node.alpha);
      const shine = night > lanternDark ? ((night - lanternDark) / (1 - lanternDark)) * a.node.alpha : 0;
      a.lantern.visible = shine > 0;
      if (!shine) continue;
      const side = a.walker.facing === "left" ? -5 : 5;
      a.lantern.position.set(a.node.x + side - 1, a.node.y - 12);
      lights.push({ x: a.node.x + side, y: a.node.y - 11, z: 10, radius: 34, color: lanternColor, intensity: 0.6 * shine });
    }
    const busy: Partial<Record<Place, number>> = {};
    const walkers: Point[] = [];
    for (const a of actors.values()) {
      if (a.walker.walking) walkers.push({ x: a.walker.x, y: a.walker.y });
      else if (atBuilding(a.goal.key)) busy[a.goal.key] = (busy[a.goal.key] ?? 0) + 1;
    }
    const ripe = plots.filter((p) => p.ripe).map((p) => toLifeBox(v.plotBox(p.bed.index)));
    // The plants in front of the camera are out of the light's reach: they take the sky's colour, a little darker.
    near.tint = lighting ? shade(flatLight(sky), 0.82) : 0xffffff;
    near.position.set(Math.round(pointer.at.x * nearLean), Math.round(pointer.at.y * nearLean));
    lights.push(...fx.lights(), ...life.update({ t, dt, night, walkers, busy, ripe, dogAsleep: !awake }));
    if (lighting) lighting.set(sky, lights, t);
    else world.tint = shade(flatLight(sky), 1);
  };
  app.ticker.add(tick);

  return {
    stage,
    helperAt: (id) => {
      const a = actors.get(id);
      return a && a.leftAt === undefined ? { x: a.walker.x, y: a.walker.y } : undefined;
    },
    destroy: () => {
      app.ticker.remove(tick);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointerleave", onLeave);
      pointer.stop();
      lighting?.destroy();
      stage.destroy();
    },
  };

  /** Shows picture `name` on a sprite, attention where the sprite is: on its feet, as the atlas says where they are. */
  function stand(sprite: Sprite, name: string) {
    sprite.texture = texture(name);
    const a = atlas.anchorOf(name);
    sprite.anchor.set(a.x, a.y);
  }
}

/** Lights a sprite up while the pointer is on what it opens; filters are only swapped when that changes. */
function glow(sprite: Sprite, on: boolean) {
  const lit = sprite.filters && (sprite.filters as readonly unknown[]).length > 0;
  if (on !== lit) sprite.filters = on ? [brighter] : [];
}

const brighter = new ColorMatrixFilter({ resolution: "inherit" });
brighter.brightness(1.25, false);

/** `rows` taller (shorter when negative) with its feet where they are: one row shows twice (or once less). */
function rise(sprite: Sprite, rows: number) {
  const h = sprite.texture.height || 1;
  sprite.scale.y = 1 + rows / h;
}

const sideOf = (f: Facing) => (f === "left" || f === "right" ? "side" : f);

interface Lean {
  readonly x: number;
  readonly stretch: number;
  readonly cast: number;
}

/** Away from the sun, longer the lower it stands; faint by moonlight. */
function shadowLean(sky: Sky): Lean {
  const [dx, , dz] = sky.sunDir;
  const slant = 1 / Math.max(dz, 0.35);
  // How far past the feet the shadow reaches; it is centred half that way, so its near end stays under them.
  const reach = Math.max(-6, Math.min(6, -dx * slant * 2.5));
  return { x: Math.round(reach / 2), stretch: 1 + Math.abs(reach) / 8, cast: 0.3 * (0.35 + 0.65 * (1 - sky.night)) };
}

function fall({ contact, cast }: Footing, at: Point, lean: Lean, fade: number) {
  contact.position.set(at.x, at.y);
  contact.alpha = contactAlpha * fade;
  cast.position.set(at.x + lean.x, at.y);
  cast.scale.x = lean.stretch;
  cast.alpha = lean.cast * fade;
}

/** A light's colour times `k`, as a tint (0xRRGGBB). */
function shade(light: readonly [number, number, number], k: number): number {
  const c = (x: number) => Math.max(0, Math.min(255, Math.round(x * k * 255)));
  return (c(light[0]) << 16) | (c(light[1]) << 8) | c(light[2]);
}
