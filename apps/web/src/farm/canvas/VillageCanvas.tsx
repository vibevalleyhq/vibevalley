// The village on the farm page: starts the
// scene (scene.ts) once the level is loaded, feeds it the latest frame and the profiles, turns its clicks into the
// farm's commands, publishes where things are on the page for the DOM over it (store screen), and wears the tool's
// cursor.

import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { Agent } from "@vibevalley/protocol";
import { useAgents } from "../../data/agents";
import { useFrames } from "../../data/frame";
import { clickBed, openPlace, useFarmCommands } from "../commands";
import { playSound } from "../sound";
import { clock, farm, farmState, subscribeFarm, type VillageScreen } from "../store";
import type { Village } from "../world/load";
import { useVillage } from "../world/load";
import { yardPlace } from "../world/places";
import { beds } from "../world/plots";
import { spriteUrl } from "../world/sprites";
import { startScene, type Scene } from "./scene";

const background = "#2b3320";

type Hotspots = Record<string, { hx: number; hy: number }>;

/** The tool's picture as a CSS cursor (1x and 2x), the system's nearest when the pictures are missing. */
function cssCursor(name: string, spots: Hotspots | undefined) {
  const fallback = name.startsWith("hand") ? "pointer" : "crosshair";
  const spot = spots?.[name];
  if (!spot) return fallback;
  return `image-set(url(/cursors/${name}.png) 1x, url(/cursors/${name}@2x.png) 2x) ${spot.hx} ${spot.hy}, ${fallback}`;
}

function screenOf(scene: Scene, village: Village, host: HTMLElement): VillageScreen {
  const { stage } = scene;
  const scale = stage.scale();
  const o = stage.offset();
  const { world } = village;
  const w = world.width * scale;
  const h = world.height * scale;
  const x0 = Math.max(0, o.x);
  const y0 = Math.max(0, o.y);
  const toScreen = (p: { x: number; y: number }) => ({ x: o.x + p.x * scale, y: o.y + p.y * scale });
  return {
    scale,
    box: { x: o.x, y: o.y, w, h },
    shown: { x: x0, y: y0, w: Math.max(0, Math.min(host.clientWidth, o.x + w) - x0), h: Math.max(0, Math.min(host.clientHeight, o.y + h) - y0) },
    toScreen,
    plotRect: (bed) => {
      const b = world.plotBox(bed);
      const p = toScreen({ x: b.x0, y: b.y0 });
      return { x: p.x, y: p.y, w: (b.x1 - b.x0) * scale, h: (b.y1 - b.y0) * scale };
    },
    helperAt: (id) => {
      const at = scene.helperAt(id);
      return at && toScreen(at);
    },
    onFrame: (fn) => {
      stage.app.ticker.add(fn, undefined, -30);
      return () => void stage.app.ticker.remove(fn);
    },
  };
}

/** `?light=off` draws without the per-pixel light (a slow GPU, a headless browser). */
const lightOn = () => new URLSearchParams(location.search).get("light") !== "off";

/** `?tod=0.9` holds the day at that time (0..1, 0.5 is noon): for looking at the night, and for screenshots. */
function holdTimeOfDay() {
  const tod = Number(new URLSearchParams(location.search).get("tod"));
  if (!new URLSearchParams(location.search).has("tod") || !Number.isFinite(tod)) return;
  clock.setTimeOfDay(tod);
  clock.setSpeed(0);
}

export function VillageCanvas() {
  const host = useRef<HTMLDivElement>(null);
  const { village, error } = useVillage();
  const { frame } = useFrames();
  const agents = useAgents().data;
  const latest = useRef({ frame, agents: new Map<string, Agent>() });
  latest.current = { frame, agents: new Map((agents ?? []).map((a) => [a.id, a])) };
  const commands = useFarmCommands();
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;
  const hotspots = useQuery({
    queryKey: ["cursors"],
    queryFn: async () => (await (await fetch("/cursors/cursors.json")).json()) as Hotspots,
    staleTime: Infinity,
  }).data;

  useEffect(() => {
    const el = host.current;
    if (!el || !village) return;
    holdTimeOfDay();
    let live = true;
    let scene: Scene | undefined;
    let stopFit = () => {};
    void startScene(
      el,
      village,
      () => latest.current,
      {
        onPlot: (bed) => {
          const c = commandsRef.current;
          if (c.aim(bed).aim.ok) playSound("tap");
          void clickBed(c, bed);
        },
        onSpot: (spot) => {
          const place = yardPlace(spot);
          if (!place) return;
          playSound("open");
          openPlace(place, (path) => void navigateRef.current(path));
        },
        onHover: (bed, spot) => farm.hover(bed, spot),
      },
      lightOn(),
    ).then((s) => {
      if (!live) return s.destroy();
      scene = s;
      stopFit = s.stage.onFit(() => farm.setScreen(screenOf(s, village, el)));
      // For tests and tools: the pictures are in and clicks are heard.
      el.dataset.ready = "true";
    });
    return () => {
      live = false;
      delete el.dataset.ready;
      stopFit();
      if (farmState().screen) farm.setScreen(null);
      scene?.destroy();
    };
  }, [village]);

  // The cursor: the tool in hand, and whether it can be used where it points.
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let pressed = false;
    const apply = () => {
      const s = farmState();
      const bed = s.hoverBed === null ? undefined : beds[s.hoverBed];
      const aim = bed ? commandsRef.current.aim(bed).aim : undefined;
      const name = !aim
        ? s.hoverSpot
          ? "hand-point"
          : s.tool
        : !aim.ok
          ? `${s.tool}-no`
          : s.tool === "hand"
            ? pressed
              ? "hand-press"
              : "hand-point"
            : pressed
              ? `${s.tool}-press`
              : `${s.tool}-ok`;
      el.style.cursor = cssCursor(name, hotspots);
    };
    const down = () => ((pressed = true), apply());
    const up = () => ((pressed = false), apply());
    el.addEventListener("pointerdown", down);
    window.addEventListener("pointerup", up);
    apply();
    const off = subscribeFarm(apply);
    return () => {
      off();
      el.removeEventListener("pointerdown", down);
      window.removeEventListener("pointerup", up);
    };
  }, [hotspots]);

  return (
    <div className="absolute inset-0 overflow-hidden" style={{ background }} aria-label="码农场物语的像素农场" role="region">
      {village && (
        <div
          aria-hidden
          className="absolute inset-0 bg-cover bg-center opacity-30 [image-rendering:pixelated]"
          style={{ backgroundImage: `url(${spriteUrl("map")})` }}
        />
      )}
      <div ref={host} className="absolute inset-0" data-testid="village" />
      {error && <p className="absolute inset-0 grid place-items-center font-pixel text-cream-200">没拿到村子的地图：{error}</p>}
    </div>
  );
}
