import { t } from "@vibevalley/i18n";
// The workbench's frame: a dark rail of places on the left (the orchestrator's face
// back to the farm at the top, 设置 and the seeds back to the farm at the bottom), and over every page but the chat a
// head with the place's name and whether the farm is open.

import { For, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { type Place, placeOf, places } from "./places";
import { useCore, useFrames } from "../base/frame";
import { OrchestratorFace } from "../ui/Face";
import { Icon } from "../ui/Icon";
import { A } from "../ui/A";
import { useRouter } from "../base/router";
import { titleBar } from "../ui/TitleBar";
import { QuickSwitcher, switcher } from "../features/channel";

/** The head's height, the rail's top slot's too. */
const head = 66;

const linkWords = { connecting: t("web.base.link.connecting"), open: t("web.base.link.open"), lost: t("web.base.link.lost") } as const;

function PlaceIcon(props: { place: Place }) {
  return <Icon name={props.place.icon} size={22} />;
}

function Slot(props: { to: string; place: string; label: string; current?: boolean; fill?: string; children: JSX.Element }) {
  return (
    <A
      href={props.to}
      data-place={props.place}
      title={props.label}
      aria-label={props.label}
      aria-current={props.current ? "page" : undefined}
      class="flex h-11 w-11 items-center justify-center overflow-hidden rounded-[10px] text-on-rail/70 hover:bg-on-rail/13 hover:text-on-rail aria-[current=page]:text-on-rail focus-visible:outline-2 focus-visible:outline-focus"
      style={props.current ? { background: props.fill ?? "color-mix(in srgb, var(--wb-on-rail) 20%, transparent)" } : undefined}
    >
      {props.children}
    </A>
  );
}

function Rail(props: { here?: Place }) {
  const frames = useFrames();
  const settings = places.find((p) => p.id === "settings")!;
  return (
    <nav
      aria-label={t("web.base.rail")}
      data-testid="rail"
      class="flex w-16 shrink-0 flex-col items-center overflow-y-auto bg-rail pb-3 md:w-20"
      // The window's buttons sit over the rail's top: it is at least as wide as they reach, and a little.
      style={titleBar.left > 0 ? { "min-width": `${titleBar.left + 8}px` } : undefined}
    >
      {/* Room for the desktop window's buttons over the rail's top. */}
      <div class="shrink-0" style={{ height: `${titleBar.top}px` }} />
      <div class="flex shrink-0 items-center justify-center" style={{ height: `${head}px` }}>
        <Slot to="/farm" place="farm" label={t("web.base.farm")} current fill="var(--wb-wheat)">
          <OrchestratorFace size={38} />
        </Slot>
      </div>
      <div class="flex flex-col gap-2">
        <For each={places.filter((p) => p.id !== "settings")}>
          {(p) => (
            <Slot to={p.path} place={p.id} label={`${p.label} · ${p.hint}`} current={p === props.here}>
              <PlaceIcon place={p} />
            </Slot>
          )}
        </For>
      </div>
      <div class="mt-auto flex flex-col items-center gap-2 pt-2">
        <Slot to={settings.path} place={settings.id} label={`${settings.label} · ${settings.hint}`} current={props.here === settings}>
          <PlaceIcon place={settings} />
        </Slot>
        <Slot to="/farm" place="farm" label={t("web.base.farm")}>
          <Icon name="farm" size={22} />
        </Slot>
        <span role="status" data-testid="link" data-state={frames.link} title={linkWords[frames.link]} class="flex h-4 items-center">
          <span
            class={["block h-2 w-2 rounded-full", frames.link === "open" ? "bg-leaf" : frames.link === "lost" ? "bg-berry" : "bg-faint"]}
            aria-hidden="true"
          />
          <span class="sr-only">{linkWords[frames.link]}</span>
        </span>
      </div>
    </nav>
  );
}

/** The head over a page: its place, and the farm's state, which goes back to the farm. */
function Desk(props: { place?: Place }) {
  const core = useCore();
  const live = () => core()?.call === "live";
  const working = () => core()?.sessions.filter((s) => s.phase._tag === "working").length ?? 0;
  const status = () => (live() ? t("web.base.working", { n: working() }) : t("web.base.off"));
  return (
    <div data-testid="desk" data-place={props.place?.id} class="flex shrink-0 items-center gap-3 border-b border-line px-5" style={{ height: `${head}px` }}>
      <Show when={props.place} fallback={<span class="flex-1" />}>
        {(place) => (
          <>
            <PlaceIcon place={place()} />
            <div class="flex min-w-0 flex-1 items-baseline gap-3">
              <h1 class="truncate text-lg font-semibold">{place().label}</h1>
              <span class="hidden truncate text-xs text-muted sm:inline">{place().hint}</span>
            </div>
          </>
        )}
      </Show>
      <A
        href="/farm"
        aria-label={status()}
        data-testid="desk-status"
        data-state={live() ? "live" : "off"}
        class="flex h-7 items-center gap-1.5 rounded-md border border-line bg-page px-2.5 text-xs hover:bg-hover"
      >
        <span class={["h-2 w-2 rounded-full", live() ? "bg-leaf" : "bg-faint"]} aria-hidden="true" />
        {status()}
      </A>
    </div>
  );
}

export function Shell(props: { children: JSX.Element }) {
  const router = useRouter();
  const here = () => placeOf(router.path().split("?")[0]!);
  // Ctrl+K (⌘K on a Mac) anywhere in the workbench.
  onSettled(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== "k") return;
      e.preventDefault();
      switcher.toggle();
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  return (
    // The interface size (设置 › 外观) scales the workbench only: zoom keeps its fixed pixel sizes in proportion.
    <div class="flex h-full [zoom:var(--workbench-zoom,1)]">
      <QuickSwitcher />
      <Rail here={here()} />
      <main class="flex min-w-0 flex-1 flex-col">
        <Show when={here()?.id !== "chat"}>
          <Desk place={here()} />
        </Show>
        <div class="min-h-0 flex-1">{props.children}</div>
      </main>
    </div>
  );
}
