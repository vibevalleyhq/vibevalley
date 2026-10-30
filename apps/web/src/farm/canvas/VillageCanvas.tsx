// The village on the farm page: starts the scene (farm/canvas/scene.ts) once the level is loaded, feeds it the latest
// frame and the profiles, turns its clicks into the farm's commands, publishes where things are on the page for the
// DOM over it (store screen), and wears the tool's cursor.

import { t } from "@vibevalley/i18n";

import { messageOf } from "@/base/format";
import { createEffect, createMemo, createSignal, Show, snapshot } from "solid-js";

import type { Agent } from "@vibevalley/protocol";
import { frames } from "@/base/frames";
import { startScene, type Scene } from "./scene";
import { background, cssCursor, holdTimeOfDay, type Hotspots, lightOn, screenOf } from "./screen";
import { clickBed, openPlace } from "@/farm/commands";
import { playSound } from "@/ui/pixel/sound";
import { farm, farmState, subscribeFarm } from "@/farm/store";
import { yardPlace } from "@/farm/world/places";
import { beds } from "@/farm/world/plots";
import { spriteUrl } from "@/ui/pixel/atlas";
import { textureProgress } from "@/farm/world/textures";
import { createExternal } from "@/base/external";
import { useRouter } from "@/base/router";
import { ready, useAgents, useQuery } from "@/base/query";
import { commands } from "@/farm/frames";
import { farmProject } from "@/farm/ui";
import { farmFrameOf } from "@/farm/scope";
import { useVillage } from "@/farm/support";

export function VillageCanvas() {
  let host!: HTMLDivElement;
  const loaded = useVillage();
  const router = useRouter();
  const agentsQuery = useAgents();
  // The scene asks for these every tick: the frame as sent, the profiles by id.
  const agents = createMemo(() => new Map<string, Agent>(ready(agentsQuery, []).map((a) => [a.id, a])));
  const hotspotsQuery = useQuery(() => ({
    queryKey: ["cursors"],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- written into public/ by design/'s build and shipped with this page
    queryFn: async () => (await (await fetch("/cursors/cursors.json")).json()) as Hotspots,
    staleTime: Infinity,
  }));
  const hotspots = () => ready(hotspotsQuery, undefined);
  // Drawn: the loading bar goes. Failed: it says why instead.
  const [drawn, setDrawn] = createSignal(false);
  const [failed, setFailed] = createSignal<string>();

  createEffect(
    () => loaded().village,
    (village) => {
      if (!village) return;
      holdTimeOfDay();
      let live = true;
      let scene: Scene | undefined;
      let stopFit = () => {};
      const latest = () => ({ frame: farmFrameOf(frames.get().frame, farmProject()), agents: agents() });
      void startScene(
        host,
        village,
        latest,
        {
          onPlot: (bed) => {
            if (commands.aim(bed).aim.ok) playSound("tap");
            void clickBed(commands, bed);
          },
          onSpot: (spot) => {
            const place = yardPlace(spot);
            if (!place) return;
            playSound("open");
            openPlace(place, (path) => router.navigate(path));
          },
          onHover: (bed, spot) => farm.hover(bed, spot),
        },
        lightOn(),
      ).then(
        (s) => {
          if (!live) return s.destroy();
          scene = s;
          stopFit = s.stage.onFit(() => farm.setScreen(screenOf(s, village, host)));
          // For tests and tools: the pictures are in and clicks are heard.
          host.dataset.ready = "true";
          setDrawn(true);
        },
        (e: unknown) => {
          console.error("vibevalley: the village did not start:", e);
          if (live) setFailed(messageOf(e));
        },
      );
      return () => {
        live = false;
        setDrawn(false);
        delete host.dataset.ready;
        stopFit();
        if (farmState().screen) farm.setScreen(undefined);
        scene?.destroy();
      };
    },
  );

  // The cursor: the tool in hand, and whether it can be used where it points.
  // The hotspots taken in the compute part: the apply part runs untracked, on every pointer move.
  createEffect(
    () => {
      const h = hotspots();
      return h ? snapshot(h) : undefined;
    },
    (spots) => {
      let pressed = false;
      const apply = () => {
        const s = farmState();
        const bed = s.hoverBed === undefined ? undefined : beds[s.hoverBed];
        const aim = bed ? commands.aim(bed).aim : undefined;
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
        host.style.cursor = cssCursor(name, spots);
      };
      const down = () => ((pressed = true), apply());
      const up = () => ((pressed = false), apply());
      host.addEventListener("pointerdown", down);
      window.addEventListener("pointerup", up);
      apply();
      const off = subscribeFarm(apply);
      return () => {
        off();
        host.removeEventListener("pointerdown", down);
        window.removeEventListener("pointerup", up);
      };
    },
  );

  return (
    <div class="absolute inset-0 overflow-hidden" style={{ background }} aria-label={t("web.farm.canvas.label")} role="region">
      <Show when={loaded().village}>
        <div
          aria-hidden="true"
          class="absolute inset-0 bg-cover bg-center opacity-30 [image-rendering:pixelated]"
          style={{ "background-image": `url(${spriteUrl("map")})` }}
        />
      </Show>
      <div ref={(el) => (host = el)} class="absolute inset-0" data-testid="village" />
      <Show when={loaded().error ?? failed()} fallback={<Show when={!drawn()}>{<Entering mapped={!!loaded().village} />}</Show>}>
        {(why) => <p class="absolute inset-0 grid place-items-center font-pixel text-cream-200">{t("web.farm.canvas.noMap", { why: why() })}</p>}
      </Show>
    </div>
  );
}

/**
 * Until the village is drawn: the map first, then its pictures one by one (most of the wait), then the light worked out
 * from them. The bar follows the pictures; the map and the light take its two ends.
 */
function Entering(props: { mapped: boolean }) {
  const pictures = createExternal(textureProgress.subscribe, textureProgress.get);
  const fill = () => {
    const { done, total } = pictures();
    if (!props.mapped || total === 0) return 0.05;
    return 0.1 + 0.8 * (done / total);
  };
  const words = () => {
    const { done, total } = pictures();
    if (!props.mapped || total === 0) return t("web.farm.canvas.map");
    return done < total ? t("web.farm.canvas.moving", { done, total }) : t("web.farm.canvas.lights");
  };
  return (
    <div class="absolute inset-0 grid place-items-center">
      <div class="flex flex-col items-center gap-2 font-pixel text-[12px] text-cream-100">
        <div
          role="progressbar"
          data-testid="village-loading"
          aria-label={t("web.farm.canvas.entering")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fill() * 100)}
          class="h-4 w-64 border-2 border-bark-900 bg-bark-900/60 p-0.5 shadow-px-shade"
        >
          <div class="h-full bg-leaf-500 transition-[width] duration-200" style={{ width: `${fill() * 100}%` }} />
        </div>
        <span>{words()}</span>
      </div>
    </div>
  );
}
