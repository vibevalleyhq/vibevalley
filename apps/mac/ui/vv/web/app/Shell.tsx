// Ported from VibeValley apps/web/src/app/Shell.tsx: the rail of places,
// the desk over a page, the page, and the quick switcher on Ctrl/⌘K (nsh's
// keymap for base/shortcuts.ts's window listener), the notes search and the
// shortcut sheet. Not here: the update slot (VibeValley's updates are the app's); the workbench zoom.
// The orchestrator's pixel face at the rail's top is the farm's icon while
// the art is not installed.
import { host, keymap, Scroll, Text, View, windowSize, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";

import { QuickSwitcher, switcher } from "../features/channel";
import { waitingOnUser } from "../features/inbox";
import { NotesSearch } from "../features/pkm";
import { useCore, useFrames } from "../infra/frame";
import { Link as A, NavLink, useLocation, useMatches } from "../infra/router";
import { OrchestratorFace } from "../ui/domain/Face";
import { Icon } from "../ui/Icon";
import type { IconName } from "../ui/icons";
import { usePixelDir } from "../ui/pixel/atlas";
import { ShortcutSheet } from "../ui/ShortcutSheet";
import { Hint } from "../ui/Tip";
import { mix } from "../ui/tone";
import { type Place, places, settingsPlace } from "./places";

const linkWords = { connecting: t("web.base.link.connecting"), open: t("web.base.link.open"), lost: t("web.base.link.lost") } as const;

/** Tailwind's `sm` (40rem): narrower, the rail is slimmer and its names go. */
const small = () => windowSize().width < 640;

/** name: none for the farm's face at the top; a place's name sits under its icon so the rail reads without hovering. */
function Slot(props: { to: string; place: string; label: string; name?: string; current?: boolean; badge?: number; icon: () => JSX.Element }) {
  const current = () => props.current === true;
  return (
    <NavLink
      href={props.to}
      testID={`place-${props.place}`}
      accessibilityLabel={props.label}
      class={[
        "items-center justify-center gap-0.5 rounded-lg",
        props.name === undefined ? (small() ? "h-11 w-11" : "h-12 w-12") : small() ? "h-12 w-12" : "h-12 w-14",
        current() ? "" : "hover:bg-hover",
      ].join(" ")}
      style={current() ? { backgroundColor: mix("on-rail", 0.09) } : undefined}
    >
      {props.icon()}
      <If when={!small() && props.name}>
        {(name) => (
          <Text class="truncate text-xs" style={{ color: current() ? mix("on-rail", 1) : mix("on-rail", 0.65) }}>
            {name()}
          </Text>
        )}
      </If>
      {/* How many wait on the user there: the place to go next, seen from anywhere. */}
      <If when={props.badge !== undefined && props.badge > 0}>
        <View testID="rail-badge" class="absolute top-0.5 right-1 min-w-4 items-center rounded-full bg-wheat px-1">
          <Text class="text-2xs font-semibold text-ink">{String(props.badge)}</Text>
        </View>
      </If>
    </NavLink>
  );
}

/** One size up from a page's head (docs/style/design.md). */
const railIcon = (name: IconName, current: () => boolean) => () => <Icon name={name} size={24} color={current() ? mix("on-rail", 1) : mix("on-rail", 0.65)} />;

const railGroups = ["work", "setup", "reference"] as const;

function Rail(props: { here?: Place | undefined; farm: boolean }) {
  const pixelDir = usePixelDir();
  const frames = useFrames();
  const waiting = () => waitingOnUser(frames.frame?.inbox ?? []);
  const settings = settingsPlace;
  const atSettings = () => props.here === settings;
  const location = useLocation();
  return (
    <View
      accessibilityLabel={t("web.base.rail")}
      testID="rail"
      class={`${small() ? "w-14" : "w-18"} shrink-0 border-r border-line bg-rail`}
      style={host.params.globalShell === true ? { width: small() ? 68 : 76 } : undefined}
    >
      <If when={host.params.globalShell === true}>
        <View class="h-7 shrink-0" />
      </If>
      <Scroll class="flex-1" contentClass="items-center pb-3">
        <View class="h-16.5 shrink-0 items-center justify-center">
          <Slot
            to="/farm"
            place="farm-face"
            label={t("web.base.farm")}
            current={props.farm}
            icon={() => (
              <View class="relative">
                <If
                  when={pixelDir()}
                  else={
                    <View class="h-9.5 w-9.5 items-center justify-center rounded-full bg-page">
                      <Icon name="farm" size={20} tone="leaf" />
                    </View>
                  }
                >
                  <OrchestratorFace size={38} />
                </If>
                {/* The link to the server, on the face: a ring of the rail's colour sets it off the picture. */}
                <View
                  testID="link"
                  accessibilityLabel={linkWords[frames.link]}
                  accessible
                  class={`absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full border-2 border-rail ${frames.link === "open" ? "bg-leaf" : frames.link === "lost" ? "bg-berry" : "bg-faint"}`}
                />
              </View>
            )}
          />
        </View>
        <View class="items-center gap-1">
          <If when={host.params.globalShell === true}>
            <Slot
              to="/workspace"
              place="workspace"
              label="工作区与终端"
              name="工作区"
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
      <View class="items-center gap-1 pt-2 pb-3">
        <Slot
          to={settings.path}
          place={settings.id}
          label={`${settings.label} · ${settings.hint}`}
          name={settings.label}
          current={atSettings()}
          icon={railIcon(settings.icon, atSettings)}
        />
        <Slot
          to="/farm"
          place="farm"
          label={t("web.base.farm")}
          name={t("web.base.farmShort")}
          current={props.farm}
          icon={railIcon("farm", () => props.farm)}
        />
      </View>
    </View>
  );
}

/** The head over a page: its place, and the farm's state, which goes back to the farm. */
function Desk(props: { place?: Place | undefined }) {
  const core = useCore();
  const live = () => core()?.call === "live";
  const working = () => core()?.sessions.filter((s) => s.phase._tag === "working").length ?? 0;
  const status = () => (live() ? t("web.base.working", { n: working() }) : t("web.base.off"));
  return (
    <View testID="desk" class="h-16.5 shrink-0 flex-row items-center gap-3 border-b border-line px-5">
      <If when={props.place} else={<View class="flex-1" />}>
        {(place) => (
          <>
            <Icon name={place().icon} size={20} />
            {/* What the place is goes beside its name, on hover: a sentence under every head was read once and then only took room. */}
            <View class="min-w-0 flex-1 flex-row items-center gap-1.5">
              <Text role="header" class="truncate text-lg font-semibold text-ink">
                {place().label}
              </Text>
              <Hint text={place().hint} />
            </View>
          </>
        )}
      </If>
      <A
        href="/farm"
        accessibilityLabel={status()}
        testID="desk-status"
        class="h-7 flex-row items-center gap-1.5 rounded-md border border-line bg-page px-2.5 hover:bg-hover"
      >
        <View class={`h-2 w-2 rounded-full ${live() ? "bg-leaf" : "bg-faint"}`} />
        <Text class="text-xs text-ink">{status()}</Text>
      </A>
    </View>
  );
}

export function Shell(props: { children: JSX.Element }) {
  const matches = useMatches();
  const meta = () => matches().at(-1)?.meta;
  const here = () => places.find((place) => place.id === meta()?.place);
  const inFarm = () => meta()?.skin === "farm";
  // Ctrl+K (⌘K on a Mac) anywhere in the workbench, in a text field too.
  keymap.bind("mod+k", () => switcher.toggle(), { when: "always" });
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
