import type { JSX } from "@solidjs/web";
import { For, onSettled, Show } from "solid-js";

import { t } from "@vibevalley/i18n";

import { pressed } from "#/base/shortcuts.ts";
import { QuickSwitcher, switcher } from "#/features/channel/index.ts";
import { waitingOnUser } from "#/features/inbox/index.ts";
import { NotesSearch } from "#/features/pkm/index.ts";
import { useCore, useFrames } from "#/infra/frame.ts";
import { Link as A, NavLink, useMatches } from "#/infra/router.ts";
import { useUpdates } from "#/infra/settings.ts";
import { OrchestratorFace } from "#/ui/domain/Face.tsx";
import { Icon } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";
import { titleBar } from "#/ui/layout.tsx";
import { ShortcutSheet } from "#/ui/ShortcutSheet.tsx";
import { Hint } from "#/ui/Tip.tsx";

import { type Place, places, settingsPlace } from "./places";

const styles = {
  railMinWidth: (minWidth: number): JSX.CSSProperties => ({ "min-width": `${minWidth}px` }),
  railTopInset: (height: number): JSX.CSSProperties => ({ height: `${height}px` }),
};

const linkWords = { connecting: t("web.base.link.connecting"), open: t("web.base.link.open"), lost: t("web.base.link.lost") } as const;

function PlaceIcon(props: { place: Place }) {
  return <Icon name={props.place.icon} size={20} />;
}

/** name: none for the farm's face at the top, which is a picture of its own; a place's name sits under its icon so the rail reads without hovering. */
function Slot(props: { to: string; place: string; label: string; name?: string; current?: boolean; badge?: number; children: JSX.Element }) {
  return (
    <NavLink
      href={props.to}
      data-place={props.place}
      title={props.label}
      aria-label={props.label}
      aria-current={props.current === true ? "page" : undefined}
      data-badge={props.badge !== undefined && props.badge > 0 ? props.badge : undefined}
      class={[
        "relative flex flex-col items-center justify-center gap-0.5 rounded-lg text-on-rail/65 hover:text-on-rail [&:where([aria-current=page])]:text-on-rail focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus",
        props.name === undefined ? "w-11 sm:w-12 h-11 sm:h-12" : "w-12 sm:w-14 h-12 [@media(width>=40rem)_and_(height>=52rem)]:h-14",
        props.current === true ? "bg-on-rail/9" : "hover:bg-on-rail/6",
      ]}
    >
      {props.children}
      <Show when={props.name}>{(name) => <span class="hidden sm:block w-full truncate text-center text-xs">{name()}</span>}</Show>
      {/* How many wait on the user there: the place to go next, seen from anywhere. */}
      <Show when={props.badge}>
        {(n) => (
          <span
            data-testid="rail-badge"
            class="absolute top-0.5 right-1 min-w-4 rounded-full bg-wheat px-1 text-center text-2xs leading-xs font-semibold text-ink"
          >
            {n()}
          </span>
        )}
      </Show>
    </NavLink>
  );
}

/** One size up from a page's head (docs/style/design.md). */
function RailIcon(props: { name: IconName }) {
  return <Icon name={props.name} size={24} />;
}

const railGroups = ["work", "setup", "reference"] as const;

function Rail(props: { here?: Place | undefined; farm: boolean }) {
  const frames = useFrames();
  const waiting = () => waitingOnUser(frames.frame?.inbox ?? []);
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
      // The window's buttons sit over the rail's top: it is at least as wide as they reach, and a little.
      class="flex w-14 sm:w-18 shrink-0 flex-col items-center overflow-y-auto border-r border-line bg-rail pb-3"
      style={titleBar.left > 0 ? styles.railMinWidth(titleBar.left + 8) : undefined}
    >
      {/* Room for the desktop window's buttons over the rail's top. */}
      <div class="shrink-0" style={styles.railTopInset(titleBar.top)} />
      <div class="flex h-16.5 shrink-0 items-center justify-center">
        <Slot to="/farm" place="farm" label={t("web.base.farm")} current={props.farm}>
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
        <Slot to="/farm" place="farm" label={t("web.base.farm")} name={t("web.base.farmShort")} current={props.farm}>
          <RailIcon name="farm" />
        </Slot>
        <span role="status" data-testid="link" data-state={frames.link} title={linkWords[frames.link]} class="flex h-4 items-center">
          <span
            class={["block h-2 w-2 rounded-full", frames.link === "open" ? "bg-leaf" : frames.link === "lost" ? "bg-berry" : "bg-faint"]}
            aria-hidden="true"
          />
          <span class="[clip-path:inset(50%)] whitespace-nowrap border-0 w-px h-px -m-px p-0 absolute overflow-hidden">{linkWords[frames.link]}</span>
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
    <div data-testid="desk" data-place={props.place?.id} class="flex h-16.5 shrink-0 items-center gap-3 border-b border-line px-5">
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
        class="flex h-7 items-center gap-1.5 rounded-md border border-line bg-page hover:bg-hover px-2.5 text-xs"
      >
        <span class={["h-2 w-2 rounded-full", live() ? "bg-leaf" : "bg-faint"]} aria-hidden="true" />
        {status()}
      </A>
    </div>
  );
}

export function Shell(props: { children: JSX.Element }) {
  const matches = useMatches();
  const meta = () => matches().at(-1)?.meta;
  const here = () => places.find((place) => place.id === meta()?.place);
  const inFarm = () => meta()?.skin === "farm";
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
    // The farm keeps integer art pixels; only workbench pages follow the interface zoom.
    <div class={["flex h-full", !inFarm() && "[zoom:var(--workbench-zoom,1)]"]}>
      <QuickSwitcher />
      <NotesSearch />
      <ShortcutSheet />
      <Rail here={here()} farm={inFarm()} />
      <main class="flex min-w-0 flex-1 flex-col">
        {/* The chat and the library draw their own one bar at the top: the place's name would be a second. */}
        <Show when={!inFarm() && here()?.id !== "chat" && here()?.id !== "library"}>
          <Desk place={here()} />
        </Show>
        <div class="relative min-h-0 flex-1">{props.children}</div>
      </main>
    </div>
  );
}
