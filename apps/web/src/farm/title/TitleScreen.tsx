import { t } from "@vibevalley/i18n";
// The title screen over the farm: the farm at the hour it is, slowly moving; the game's name; the menu: 开始游戏,
// 继续游戏 (when there is a farm to go back to), 设置. Arrow keys and Enter work as in a game; leaving it, it does not
// show again on this machine. Without the orchestrator's key 开始游戏 says so in place: the workbench pages have no toasts to
// carry it there.

import { createSignal, For, onSettled, Show } from "solid-js";
import { api } from "../../base/api";
import { playSound } from "../../ui/pixel/sound";
import { farm } from "../store";
import { hasFarm, orchestratorReady } from "./rules";
import { startScene } from "./scene";
import { useRouter } from "../../base/router";
import { useCore } from "../../base/frame";
import { ready, useSettings } from "../../base/query";
import { TitleStage } from "./TitleStage";

type Item = "start" | "continue" | "settings";

// Text shadows go inline: the pixel skin turns a class with "shadow" in it into a box's drop.
const deep = { "text-shadow": "4px 4px 0 #3a2a18" };
const soft = { "text-shadow": "2px 2px 0 #3a2a18" };

export function TitleScreen() {
  const router = useRouter();
  const core = useCore();
  const canContinue = () => hasFarm(core());
  const settings = useSettings();
  const items = () => [
    { id: "start" as const, label: t("web.farm.title.start"), enabled: true },
    { id: "continue" as const, label: t("web.farm.title.continue"), enabled: canContinue() },
    { id: "settings" as const, label: t("web.farm.chat.settingsLink"), enabled: true },
  ];
  const [picked, setPicked] = createSignal<Item>();
  const [note, setNote] = createSignal<string>();
  const at = () => picked() ?? (canContinue() ? "continue" : "start");

  const choose = (item: Item) => {
    playSound("tap");
    switch (item) {
      case "start":
        // The orchestrator cannot think without DeepSeek's key: say so under the menu, where 设置 is.
        if (!orchestratorReady(ready(settings, undefined))) return setNote(t("web.farm.title.keyFirst"));
        farm.closeTitle();
        return void api.orchestrator.open().catch(() => {});
      case "continue":
        return canContinue() ? farm.closeTitle() : undefined;
      case "settings":
        farm.closeTitle();
        return router.navigate("/settings/models");
    }
  };

  onSettled(() => {
    const onKey = (e: KeyboardEvent) => {
      const open = items().filter((i) => i.enabled);
      const here = open.findIndex((i) => i.id === at());
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const next = open[(here + (e.key === "ArrowDown" ? 1 : open.length - 1)) % open.length];
        if (next) setPicked(next.id);
        playSound("pick");
      } else if (e.key === "Enter") {
        e.preventDefault();
        choose(at());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div class="absolute inset-0 z-[60] overflow-hidden bg-dusk-800 font-pixel" role="dialog" aria-label={t("web.farm.title.label")} data-testid="title">
      <TitleStage scene={startScene()} />
      <div class="absolute inset-y-0 left-0 w-[min(46rem,70vw)] bg-gradient-to-r from-dusk-900/75 via-dusk-900/35 to-transparent" />
      <div class="relative flex h-full flex-col justify-center gap-8 overflow-y-auto px-[6vw] py-8 sm:gap-10">
        <header class="title-float">
          <h1 class="text-[clamp(40px,6vw,72px)] leading-none text-cream-50" style={deep}>
            {t("web.farm.title.name")}
          </h1>
          <p class="mt-3 text-[24px] text-cream-100" style={soft}>
            {t("web.farm.title.tagline")}
          </p>
        </header>
        <nav class="flex w-56 flex-col gap-3" aria-label={t("web.farm.sow.start")}>
          <For each={items()} keyed={(item) => item.id}>
            {(item, i) => {
              const on = () => at() === item().id && item().enabled;
              return (
                <button
                  type="button"
                  data-key={item().id}
                  data-picked={on() ? "" : undefined}
                  disabled={!item().enabled}
                  onMouseEnter={() => item().enabled && setPicked(item().id)}
                  onClick={() => choose(item().id)}
                  style={{ "--delay": `${i() * 90}ms`, "box-shadow": "2px 2px 0 0 #3a2a1899" }}
                  class={[
                    "title-in flex cursor-pointer items-center gap-2 border-2 border-bark-850 px-4 py-2.5 text-left text-[24px] leading-[1.4] text-bark-900 transition-transform duration-150 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45",
                    on() ? "translate-x-2 bg-glow" : "bg-glow-soft",
                  ]}
                >
                  <PickedMark shown={on()} />
                  {item().label}
                </button>
              );
            }}
          </For>
          <Show when={note()}>
            <p role="status" class="bg-glow px-2 py-1 text-[12px] text-bark-900">
              {note()}
            </p>
          </Show>
          <Show when={!canContinue()}>
            <p class="px-1 text-[12px] text-cream-100" style={soft}>
              {t("web.farm.title.nothingToContinue")}
            </p>
          </Show>
        </nav>
      </div>
    </div>
  );
}

/** The arrow at the picked item: a pixel triangle in berry. */
function PickedMark(props: { shown: boolean }) {
  return (
    <svg width={12} height={18} viewBox="0 0 4 6" shape-rendering="crispEdges" aria-hidden="true" class={["mr-1 shrink-0", { invisible: !props.shown }]}>
      <rect x={0} y={0} width={1} height={6} fill="#c84a3a" />
      <rect x={1} y={1} width={1} height={4} fill="#c84a3a" />
      <rect x={2} y={2} width={1} height={2} fill="#c84a3a" />
    </svg>
  );
}
