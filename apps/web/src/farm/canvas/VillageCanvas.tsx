import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, Show, snapshot, untrack } from "solid-js";
// The village on the farm page: starts the scene (farm/canvas/scene.ts) once the level is loaded, feeds it the latest frame and the profiles, turns its clicks into the farm's commands, publishes where things are on the page for the DOM over it (store screen), and wears the tool's cursor.

import { t } from "@vibevalley/i18n";
import type { Agent } from "@vibevalley/protocol";

import { createExternal } from "#/base/external.ts";
import { messageOf } from "#/base/format.ts";
import { clickBed, openPlace } from "#/farm/commands.ts";
import { commands, farmFrameOf } from "#/farm/frames.ts";
import { farm, farmRepo, farmState, subscribeFarm } from "#/farm/store.ts";
import { useVillage } from "#/farm/world/load.ts";
import { beds } from "#/farm/world/plots.ts";
import { textureProgress } from "#/farm/world/textures.ts";
import { yardPlace } from "#/farm/world/world.ts";
import { frames } from "#/infra/frame.ts";
import { cursorsQuery, ready, useAgents, useQuery } from "#/infra/query.ts";
import { useRouter } from "#/infra/router.ts";
import { spriteUrl } from "#/ui/pixel/atlas.ts";
import { playSound } from "#/ui/pixel/sound.ts";

import { startScene, type Scene } from "./scene";
import { background, cssCursor, holdTimeOfDay, lightOn, screenOf } from "./screen";

const styles = stylex.create({
  enteringDiv: {
    height: "1rem",
    width: "16rem",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-900)",
    backgroundColor: {
      default: "var(--color-px-canvas-shade)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-bark-900) 60%, transparent)",
    },
    padding: "0.125rem",
    boxShadow: "2px 2px 0 0 var(--color-px-shade)",
  },
  villageCanvasDiv: {
    position: "absolute",
    inset: "0",
    overflow: "hidden",
  },
  villageCanvasDiv2: {
    position: "absolute",
    inset: "0",
    backgroundSize: "cover",
    backgroundPosition: "50%",
    opacity: ".3",
    imageRendering: "pixelated",
  },
  village: {
    position: "absolute",
    inset: "0",
  },
  villageError: {
    position: "absolute",
    inset: "0",
    display: "grid",
    placeItems: "center",
    fontFamily: "var(--font-pixel)",
    color: "var(--color-cream-200)",
  },
  enteringDiv2: {
    position: "absolute",
    inset: "0",
    display: "grid",
    placeItems: "center",
  },
  enteringDiv22: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    gap: "0.5rem",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    color: "var(--color-cream-100)",
  },
  enteringDiv3: {
    height: "100%",
    backgroundColor: "var(--color-leaf-500)",
    transitionProperty: "width",
    transitionTimingFunction: "var(--ease-out)",
    transitionDuration: ".2s",
  },
});

export function VillageCanvas() {
  let host!: HTMLDivElement;
  const loaded = useVillage();
  const router = useRouter();
  const agentsQuery = useAgents();
  // The scene asks for these every tick: the frame as sent, the profiles by id.
  const agents = createMemo(() => new Map<string, Agent>(ready(agentsQuery, []).map((a) => [a.id, a])));
  const hotspotsQuery = useQuery(cursorsQuery);
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
      const latest = () => ({ frame: farmFrameOf(frames.get().frame, farmRepo()), agents: agents() });
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
  createEffect(
    () => {
      const h = hotspots();
      return h ? snapshot(h) : undefined;
    },
    (spots) => {
      let pressed = false;
      const apply = () => {
        const s = untrack(farmState);
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
    <div {...stylex.attrs(styles.villageCanvasDiv)} style={{ background }} aria-label={t("web.farm.canvas.label")} role="region">
      <Show when={loaded().village}>
        <div aria-hidden="true" {...stylex.attrs(styles.villageCanvasDiv2)} style={{ "background-image": `url(${spriteUrl("map")})` }} />
      </Show>
      <div ref={(el) => (host = el)} {...stylex.attrs(styles.village)} data-testid="village" />
      <Show when={loaded().error ?? failed()} fallback={<Show when={!drawn()}>{<Entering mapped={!!loaded().village} />}</Show>}>
        {(why) => (
          <p data-testid="village-error" data-opening="failed" {...stylex.attrs(styles.villageError)}>
            {t("web.farm.canvas.noMap", { why: why() })}
          </p>
        )}
      </Show>
    </div>
  );
}

/** Until the village is drawn: the map first, then its pictures one by one (most of the wait), then the light worked out from them. */
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
    <div {...stylex.attrs(styles.enteringDiv2)} data-opening="pending" data-opening-progress={fill()}>
      <div {...stylex.attrs(styles.enteringDiv22)}>
        <div
          role="progressbar"
          data-testid="village-loading"
          aria-label={t("web.farm.canvas.entering")}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(fill() * 100)}
          {...stylex.attrs(styles.enteringDiv)}
        >
          <div {...stylex.attrs(styles.enteringDiv3)} style={{ width: `${fill() * 100}%` }} />
        </div>
        <span>{words()}</span>
      </div>
    </div>
  );
}
