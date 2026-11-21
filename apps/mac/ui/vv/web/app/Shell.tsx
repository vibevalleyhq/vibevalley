// Ported from VibeValley apps/web/src/app/Shell.tsx: the rail of places,
// the desk over a page, the page, and the quick switcher on Ctrl/⌘K (nsh's
// keymap for base/shortcuts.ts's window listener), the notes search and the
// shortcut sheet.
// The orchestrator's pixel face at the rail's top is the farm's icon while
// the art is not installed.
import { colorScheme, effect, host, keymap, Scroll, Text, View, windowSize, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";

import { Keyed, variant } from "../base/dom";
import { QuickSwitcher, switcher } from "../features/channel";
import { waitingOnUser } from "../features/inbox";
import { NotesSearch } from "../features/pkm";
import { useCore, useFrames } from "../infra/frame";
import { Link as A, NavLink, useLocation, useMatches } from "../infra/router";
import { useUpdates } from "../infra/settings";
import { OrchestratorFace } from "../ui/domain/Face";
import { Icon } from "../ui/Icon";
import type { IconName } from "../ui/icons";
import { usePixelDir } from "../ui/pixel/atlas";
import { ShortcutSheet } from "../ui/ShortcutSheet";
import { Bubble, Hint } from "../ui/Tip";
import { mix } from "../ui/tone";
import { type Place, places, runsPlace, settingsPlace } from "./places";

const linkWords = { connecting: t("web.base.link.connecting"), open: t("web.base.link.open"), lost: t("web.base.link.lost") } as const;

/** Tailwind's `sm` (40rem): narrower, the rail is slimmer and its names go. */
const small = () => windowSize().width < 640;
/** Short windows (<760px tall): tighten rail vertical rhythm so all 9 nav items fit without clipping. */
const compactTall = () => windowSize().height < 760;

/** A place on the rail: 24px icon (or the 38px farm anchor) with its short name underneath so it reads without hovering. */
function Slot(props: { to: string; place: string; label: string; name?: string; current?: boolean; badge?: number; hero?: boolean; icon: () => JSX.Element }) {
  const current = () => props.current === true;
  const hero = () => props.hero === true;
  const badgeText = () => {
    const n = props.badge ?? 0;
    return n > 99 ? "99+" : String(n);
  };
  return (
    <NavLink
      href={props.to}
      testID={`place-${props.place}`}
      accessibilityLabel={props.label}
      tooltip={<Bubble text={props.label} placement="right" />}
      class={[
        "relative items-center justify-center gap-0.5 rounded-lg px-0.5 transition duration-120 ease-out",
        hero() ? (small() ? "h-12 w-12" : compactTall() ? "h-15.5 w-16" : "h-16 w-16") : small() ? "h-11 w-11" : compactTall() ? "h-11.5 w-16" : "h-12.5 w-16",
        current() ? "" : "hover:bg-hover",
      ].join(" ")}
      style={current() ? { backgroundColor: mix("on-rail", colorScheme() === "dark" ? 0.12 : 0.09) } : undefined}
    >
      <If when={current()}>
        <View class="absolute top-0 bottom-0 left-0 justify-center">
          <View class="h-4 w-0.5 rounded-full bg-accent" />
        </View>
      </If>
      {props.icon()}
      <If when={!small() && props.name}>
        {(name) => (
          <Text
            class="w-full truncate text-center font-sans text-2xs leading-tight font-medium"
            style={{ color: current() ? mix("on-rail", 1) : mix("on-rail", 0.65) }}
          >
            {name()}
          </Text>
        )}
      </If>
      {/* How many wait on the user there: the place to go next, seen from anywhere. */}
      <If when={props.badge !== undefined && props.badge > 0}>
        <View
          testID="rail-badge"
          class={`absolute ${small() ? "top-0.5 right-0.5" : "top-0.5 right-1"} h-4 min-w-4 items-center justify-center rounded-full border border-rail bg-wheat px-1`}
        >
          {/* Dark bark ink on wheat keeps >7:1 contrast in both light and dark themes (docs/design/01-philosophy-and-tokens.md). */}
          <Text class="font-sans text-2xs leading-none font-semibold text-bark-900 tabular-nums">{badgeText()}</Text>
        </View>
      </If>
    </NavLink>
  );
}

/** One size up from a page's head (docs/design/01-philosophy-and-tokens.md). */
const railIcon = (name: IconName, current: () => boolean) => () => <Icon name={name} size={24} color={current() ? mix("on-rail", 1) : mix("on-rail", 0.65)} />;

const railGroups = ["work", "setup", "reference"] as const;

function Rail(props: { here?: Place | undefined; farm: boolean }) {
  const pixelDir = usePixelDir();
  const frames = useFrames();
  const updates = useUpdates();
  const ready = () => {
    const s = updates();
    return s ? variant(s, "_tag", "ready") : undefined;
  };
  const waiting = () => waitingOnUser(frames.frame?.inbox ?? []);
  const settings = settingsPlace;
  const atSettings = () => props.here === settings;
  const location = useLocation();
  const globalShell = host.params.globalShell === true;
  const width = () => (globalShell ? (small() ? 68 : 76) : props.farm ? (small() ? 56 : 72) : small() ? 68 : 76);
  if (globalShell) {
    effect(() => host.post("action", { type: "global_rail", rail_width: width() }));
  }
  return (
    <View
      accessibilityLabel={t("web.base.rail")}
      testID="rail"
      class={`${small() ? "w-14" : "w-18"} shrink-0 border-r border-line bg-rail pl-px`}
      style={globalShell ? { width: width() } : undefined}
    >
      <If when={globalShell}>
        <View class="h-7 shrink-0" />
      </If>
      <View class={`shrink-0 items-center ${globalShell ? "pt-1 pb-2" : compactTall() ? "pt-1.5 pb-2" : "pt-2 pb-2"}`}>
        <Slot
          to="/farm"
          place="farm"
          label={`${t("web.base.farm")} · ${linkWords[frames.link]}`}
          name={t("web.base.farmShort")}
          current={props.farm}
          hero
          icon={() => (
            <View class="relative">
              <View class="overflow-hidden rounded-md border border-line">
                <If
                  when={pixelDir()}
                  else={
                    <View class="h-9.5 w-9.5 items-center justify-center bg-page">
                      <Icon name="farm" size={20} tone="leaf" />
                    </View>
                  }
                >
                  <OrchestratorFace size={38} />
                </If>
              </View>
              <View
                testID="link"
                accessibilityLabel={linkWords[frames.link]}
                accessible
                class={`absolute -right-1 -bottom-1 h-3 w-3 rounded-full border-2 border-rail ${frames.link === "open" ? "bg-leaf" : frames.link === "lost" ? "bg-berry" : "bg-faint"}`}
              />
            </View>
          )}
        />
      </View>
      <View class="self-center h-px w-8 shrink-0" style={{ backgroundColor: mix("on-rail", 0.1) }} />
      <Scroll class="flex-1" contentClass="items-center py-2">
        <View class="items-center gap-1">
          <If when={globalShell}>
            <Slot
              to="/workspace"
              place="workspace"
              label={t("web.base.place.workspace.hint")}
              name={t("web.base.place.workspace.label")}
              current={location().pathname === "/workspace"}
              icon={railIcon("terminal", () => location().pathname === "/workspace")}
            />
          </If>
          <Each of={railGroups}>
            {(group, i) => (
              <View class="items-center gap-1">
                <If when={i() > 0}>
                  <View class="my-1 h-px w-8" style={{ backgroundColor: mix("on-rail", 0.1) }} />
                </If>
                <Each of={places.filter((p) => p.group === group() && p.id !== "settings")}>
                  {(p) => (
                    <Slot
                      to={p().path}
                      place={p().id}
                      label={`${p().label} · ${p().hint}`}
                      name={p().label}
                      current={p() === props.here}
                      badge={p().id === "issues" ? waiting() : 0}
                      icon={railIcon(p().icon, () => p() === props.here)}
                    />
                  )}
                </Each>
              </View>
            )}
          </Each>
        </View>
      </Scroll>
      <View class="shrink-0 items-center gap-1 pt-2 pb-3">
        <View class="mb-1 h-px w-8" style={{ backgroundColor: mix("on-rail", 0.1) }} />
        <If when={ready()}>
          {(r) => (
            <Slot
              to="/settings/about"
              place="update"
              label={t("web.base.updateReady", { next: r().next })}
              name={t("web.base.update")}
              icon={railIcon("update", () => false)}
            />
          )}
        </If>
        <Slot
          to={settings.path}
          place={settings.id}
          label={`${settings.label} · ${settings.hint}`}
          name={settings.label}
          current={atSettings()}
          icon={railIcon(settings.icon, atSettings)}
        />
      </View>
    </View>
  );
}

type DeskRunState = "working" | "idle" | "offline";

function deskRunStateOf(call: string | undefined, working: number): DeskRunState {
  if (working > 0) return "working";
  return call === "live" ? "idle" : "offline";
}

interface DeskRunPresentation {
  readonly label: string;
  readonly pillClass: (onRuns: boolean) => string;
  readonly pillStyle: (onRuns: boolean) => Record<string, string> | undefined;
  readonly pillHoverStyle: (onRuns: boolean) => Record<string, string> | undefined;
  readonly haloBg: () => string | undefined;
  readonly dotClass: string;
  readonly textClass: string;
}

function deskRunPresentation(state: DeskRunState, workingCount: number): DeskRunPresentation {
  switch (state) {
    case "working":
      return {
        label: t("web.base.working", { n: workingCount }),
        pillClass: (onRuns) => (onRuns ? "border-focus bg-selected" : ""),
        pillStyle: (onRuns) => (onRuns ? undefined : { backgroundColor: mix("leaf", 0.1), borderColor: mix("leaf", 0.45) }),
        pillHoverStyle: (onRuns) => (onRuns ? undefined : { backgroundColor: mix("leaf", 0.16) }),
        haloBg: () => mix("leaf", 0.25),
        dotClass: "bg-leaf",
        textClass: "font-semibold text-ink tabular-nums",
      };
    case "idle":
      return {
        label: t("web.base.working", { n: 0 }),
        pillClass: (onRuns) => (onRuns ? "border-accent bg-selected" : "border-line bg-side hover:bg-selected"),
        pillStyle: () => undefined,
        pillHoverStyle: () => undefined,
        haloBg: () => undefined,
        dotClass: "bg-leaf",
        textClass: "font-medium text-muted tabular-nums",
      };
    case "offline":
      return {
        label: t("web.base.off"),
        pillClass: (onRuns) => (onRuns ? "border-accent bg-selected" : "border-line bg-side hover:bg-selected"),
        pillStyle: () => undefined,
        pillHoverStyle: () => undefined,
        haloBg: () => undefined,
        dotClass: "bg-idle",
        textClass: "font-medium text-muted",
      };
  }
}

/** The head over a page: its place, and the live runs status pill, which opens /runs. */
function Desk(props: { place?: Place | undefined }) {
  const core = useCore();
  const working = () => core()?.sessions.filter((s) => s.phase._tag === "working").length ?? 0;
  const runState = () => deskRunStateOf(core()?.call, working());
  const view = () => deskRunPresentation(runState(), working());
  const onRuns = () => props.place?.id === "runs";
  const haloStyle = () => {
    const bg = view().haloBg();
    return bg !== undefined ? { backgroundColor: bg } : undefined;
  };
  return (
    <View testID="desk" class="h-16.5 shrink-0 flex-row items-center justify-between gap-4 border-b border-line px-5">
      <If when={props.place} else={<View class="flex-1" />}>
        {(place) => (
          <View class="min-w-0 flex-1 flex-row items-center gap-2.5">
            <Keyed key={place().icon}>{() => <Icon name={place().icon} size={20} />}</Keyed>
            {/* What the place is goes beside its name, on hover: a sentence under every head was read once and then only took room. */}
            <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
              <Text role="header" class="truncate text-lg font-semibold text-ink">
                {place().label}
              </Text>
              <Hint text={place().hint} />
            </View>
          </View>
        )}
      </If>
      <A
        href="/runs"
        accessibilityLabel={view().label}
        testID="desk-status"
        tooltip={<Bubble text={t("web.base.runsHint")} placement="bottom" />}
        class={`h-7 shrink-0 flex-row items-center gap-2 rounded-full border px-3 transition duration-120 ease-out active:translate-y-px ${view().pillClass(onRuns())}`}
        style={view().pillStyle(onRuns())}
        hoverStyle={view().pillHoverStyle(onRuns())}
      >
        <View class="size-3.5 shrink-0 items-center justify-center rounded-full" style={haloStyle()}>
          <View class={`size-2 rounded-full ${view().dotClass}`} />
        </View>
        <Text class={`text-xs ${view().textClass}`}>{view().label}</Text>
      </A>
    </View>
  );
}

export function Shell(props: { children: JSX.Element }) {
  const matches = useMatches();
  const meta = () => matches().at(-1)?.meta;
  const here = () => {
    const id = meta()?.place;
    if (id === runsPlace.id) return runsPlace;
    return places.find((place) => place.id === id);
  };
  const inFarm = () => meta()?.skin === "farm";
  // Ctrl+J (⌘J on a Mac) opens the channel quick switcher without colliding with global ⌘K command palette.
  keymap.bind("mod+j", () => switcher.toggle(), { when: "always" });
  return (
    <View class="flex-1 flex-row bg-page">
      <QuickSwitcher />
      <NotesSearch />
      <ShortcutSheet />
      <Rail here={here()} farm={inFarm()} />
      <View class="min-w-0 flex-1">
        {/* The chat and the library draw their own one bar at the top: the place's name would be a second. */}
        <If when={!inFarm() && here()?.id !== "chat" && here()?.id !== "library"}>
          <Desk place={here()} />
        </If>
        <View class="min-h-0 flex-1">{props.children}</View>
      </View>
    </View>
  );
}
