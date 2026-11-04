import type { JSX } from "@solidjs/web";
import { For, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { pressed } from "#/base/shortcuts.ts";
import { QuickSwitcher, switcher } from "#/features/channel/index.ts";
import { waitingOnOwner } from "#/features/inbox/index.ts";
import { NotesSearch } from "#/features/pkm/index.ts";
import { useCore, useFrames } from "#/infra/frame.ts";
import { useRouter } from "#/infra/router.ts";
import { useUpdates } from "#/infra/settings.ts";
import { A } from "#/ui/A.tsx";
import { OrchestratorFace } from "#/ui/Face.tsx";
import { Icon } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";
import { titleBar } from "#/ui/layout.tsx";
import { ShortcutSheet } from "#/ui/ShortcutSheet.tsx";
import { Hint } from "#/ui/Tip.tsx";

import { type Place, placeOf, places, settingsPlace } from "./places";

/** The head's height, the rail's top slot's too. */
const head = 66;

const linkWords = { connecting: t("web.base.link.connecting"), open: t("web.base.link.open"), lost: t("web.base.link.lost") } as const;

function PlaceIcon(props: { place: Place }) {
  return <Icon name={props.place.icon} size={20} />;
}

/** name: none for the farm's face at the top, which is a picture of its own; a place's name sits under its icon so the rail reads without hovering. */
function Slot(props: { to: string; place: string; label: string; name?: string; current?: boolean; badge?: number; children: JSX.Element }) {
  return (
    <A
      href={props.to}
      data-place={props.place}
      title={props.label}
      aria-label={props.label}
      aria-current={props.current === true ? "page" : undefined}
      data-badge={props.badge !== undefined && props.badge > 0 ? props.badge : undefined}
      class={[
        "relative flex flex-col items-center justify-center gap-0.5 rounded-lg text-on-rail/65 hover:bg-on-rail/6 hover:text-on-rail focus-visible:outline-2 focus-visible:outline-focus aria-[current=page]:text-on-rail",
        // The farm's face at the top is a square picture; a place is a square of its icon and name, of its icon alone on a
        // phone, where the rail gives the page all it can.
        props.name === undefined ? "size-11 sm:size-12" : "size-12 sm:size-14",
      ]}
      style={props.current === true ? { background: "color-mix(in srgb, var(--wb-on-rail) 9%, transparent)" } : undefined}
    >
      {props.children}
      <Show when={props.name}>{(name) => <span class="hidden w-full truncate text-center text-xs leading-4 sm:block">{name()}</span>}</Show>
      {/* How many wait on the owner there: the place to go next, seen from anywhere. */}
      <Show when={props.badge}>
        {(n) => (
          <span
            data-testid="rail-badge"
            class="absolute top-0.5 right-1 min-w-4 rounded-full bg-wheat px-1 text-center text-2xs leading-4 font-semibold text-ink"
          >
            {n()}
          </span>
        )}
      </Show>
    </A>
  );
}

/** One size up from a page's head (docs/style/design.md, 图标). */
function RailIcon(props: { name: IconName }) {
  return <Icon name={props.name} size={24} />;
}

const railGroups = ["work", "setup", "reference"] as const;

function Rail(props: { here?: Place | undefined }) {
  const frames = useFrames();
  const waiting = () => waitingOnOwner(frames.frame?.inbox ?? []);
  const settings = settingsPlace;
  const updates = useUpdates();
  const ready = () => {
    const s = updates();
    return s?._tag === "ready" ? s : undefined;
  };
  return (
    <nav
      aria-label={t("web.base.rail")}
      data-testid="rail"
      class="flex w-14 shrink-0 flex-col items-center overflow-y-auto border-r border-line bg-rail pb-3 sm:w-18"
      // The window's buttons sit over the rail's top: it is at least as wide as they reach, and a little.
      style={titleBar.left > 0 ? { "min-width": `${titleBar.left + 8}px` } : undefined}
    >
      {/* Room for the desktop window's buttons over the rail's top. */}
      <div class="shrink-0" style={{ height: `${titleBar.top}px` }} />
      <div class="flex shrink-0 items-center justify-center" style={{ height: `${head}px` }}>
        <Slot to="/farm" place="farm" label={t("web.base.farm")}>
          <OrchestratorFace size={38} />
        </Slot>
      </div>
      <div class="flex flex-col items-center gap-1">
        <For each={railGroups}>
          {(group, i) => (
            <>
              <Show when={i() > 0}>
                <span aria-hidden="true" class="my-1 h-px w-8 bg-on-rail/10" />
              </Show>
              <For each={places.filter((p) => p.group === group && p.id !== "settings")}>
                {(p) => (
                  <Slot
                    to={p.path}
                    place={p.id}
                    label={`${p.label} · ${p.hint}`}
                    name={p.label}
                    current={p === props.here}
                    badge={p.id === "issues" ? waiting() : 0}
                  >
                    <RailIcon name={p.icon} />
                  </Slot>
                )}
              </For>
            </>
          )}
        </For>
      </div>
      <div class="mt-auto flex flex-col items-center gap-1 pt-2">
        <Show when={ready()}>
          {(r) => (
            <Slot to="/settings/about" place="update" label={t("web.base.updateReady", { next: r().next })} name={t("web.base.update")}>
              <RailIcon name="update" />
            </Slot>
          )}
        </Show>
        <Slot to={settings.path} place={settings.id} label={`${settings.label} · ${settings.hint}`} name={settings.label} current={props.here === settings}>
          <RailIcon name={settings.icon} />
        </Slot>
        <Slot to="/farm" place="farm" label={t("web.base.farm")} name={t("web.base.farmShort")}>
          <RailIcon name="farm" />
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
function Desk(props: { place?: Place | undefined }) {
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
            {/* What the place is goes beside its name, on hover: a sentence under every head was read once and then only took room. */}
            <div class="flex min-w-0 flex-1 items-center gap-1.5">
              <h1 class="truncate text-lg font-semibold">{place().label}</h1>
              <Hint text={place().hint} />
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
  const here = () => placeOf(router.path().split("?")[0] ?? "");
  // Ctrl+K (⌘K on a Mac) anywhere in the workbench (base/shortcuts.ts).
  onSettled(() => {
    const key = (e: KeyboardEvent) => {
      if (!pressed(e, "switcher")) return;
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
      <NotesSearch />
      <ShortcutSheet />
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
