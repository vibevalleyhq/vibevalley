import { colorScheme, effect, host, keymap, Scroll, Text, View, windowSize, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import { isFreeUserSession } from "@vibevalley/protocol/rules";

import { Button } from "../design/Button";
import { OrchestratorFace } from "../design/domain/Face";
import { Icon } from "../design/Icon";
import { IconButton } from "../design/IconButton";
import type { IconName } from "../design/icons";
import { motionClass } from "../design/motion";
import { usePixelDir } from "../design/pixel/atlas";
import { ShortcutSheet } from "../design/ShortcutSheet";
import { Tabs } from "../design/Tabs";
import { Bubble } from "../design/Tip";
import { mix } from "../design/tone";
import { QuickSwitcher, switcher } from "../features/channel";
import { contentSidebarOpen, openContentSearch, openTemplatePicker, safeLastContentPath } from "../features/content";
import { waitingOnUser } from "../features/inbox";
import { Keyed, variant } from "../infra/base/dom";
import { useInboxSlice, useLink, useSessionsSlice } from "../infra/frame";
import { readHostParams } from "../infra/hostParams";
import { NavLink, useLocation, useMatches } from "../infra/router";
import { useUpdates } from "../infra/settings";
import { catalogPlace, type Place, places, runsPlace, settingsPlace } from "./places";

const linkWords = { connecting: t("web.base.link.connecting"), open: t("web.base.link.open"), lost: t("web.base.link.lost") } as const;

/** Tailwind's `sm` (40rem): narrower, the rail is slimmer and its names go. */
const small = () => windowSize().width < 640;
/** Short windows (<760px tall): tighten rail vertical rhythm so all 9 nav items fit without clipping. */
const compactTall = () => windowSize().height < 760;

/** 24px icon (or the 38px farm anchor) with its short name underneath, so it reads without hovering. */
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
        "relative items-center justify-center gap-0.5 rounded-lg px-0.5",
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

const railGroups = ["work", "setup"] as const;

function Rail(props: { here?: Place | undefined; farm: boolean }) {
  const pixelDir = usePixelDir();
  const sessions = useSessionsSlice();
  const inbox = useInboxSlice();
  const link = useLink();
  const updates = useUpdates();
  const ready = () => {
    const s = updates();
    return s ? variant(s, "_tag", "ready") : undefined;
  };
  const waiting = () => waitingOnUser(inbox()?.items ?? []);
  const working = () => sessions()?.sessions.filter((s) => !isFreeUserSession(s) && s.phase._tag === "working").length ?? 0;
  const onRuns = () => props.here === runsPlace;
  const settings = settingsPlace;
  const atSettings = () => props.here === settings;
  const location = useLocation();
  const globalShell = readHostParams().globalShell;
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
        <View class="h-7 shrink-0" desktop={{ windowDrag: true }} />
      </If>
      <View class={`shrink-0 items-center ${globalShell ? "pt-1 pb-2" : compactTall() ? "pt-1.5 pb-2" : "pt-2 pb-2"}`}>
        <Slot
          to="/farm"
          place="farm"
          label={`${t("web.base.farm")} · ${linkWords[link()]}`}
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
                accessibilityLabel={linkWords[link()]}
                accessible
                class={`absolute -right-1 -bottom-1 h-3 w-3 rounded-full border-2 border-rail ${link() === "open" ? "bg-leaf" : link() === "lost" ? "bg-berry" : "bg-faint"}`}
              />
            </View>
          )}
        />
      </View>
      <View class="self-center h-px w-8 shrink-0" style={{ backgroundColor: mix("on-rail", 0.1) }} />
      <Scroll class="flex-1" contentClass="items-center py-2">
        <View class="items-center gap-1">
          <Each of={railGroups}>
            {(group, i) => (
              <View class="items-center gap-1">
                <If when={i() > 0}>
                  <View class="my-1 h-px w-8" style={{ backgroundColor: mix("on-rail", 0.1) }} />
                </If>
                <Each of={places.filter((p) => p.group === group() && p.id !== "settings")}>
                  {(p) => {
                    const to = () => (p().id === "workspace" && globalShell ? "/workspace" : p().id === "content" ? safeLastContentPath() : p().path);
                    const isCurrent = () => (p().id === "workspace" ? location().pathname === "/workspace" || p() === props.here : p() === props.here);
                    return (
                      <Slot
                        to={to()}
                        place={p().id}
                        label={`${p().label} · ${p().hint}`}
                        name={p().label}
                        current={isCurrent()}
                        badge={p().id === "issues" ? waiting() : 0}
                        icon={railIcon(p().icon, isCurrent)}
                      />
                    );
                  }}
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
        <NavLink
          href="/runs"
          testID="rail-runs-status"
          accessibilityLabel={working() > 0 ? t("web.base.working", { n: working() }) : t("web.base.runsHint")}
          tooltip={
            <Bubble
              text={working() > 0 ? `${t("web.base.working", { n: working() })} · ${t("web.base.runsHint")}` : t("web.base.runsHint")}
              placement="right"
            />
          }
          class={`h-7 shrink-0 flex-row items-center justify-center gap-1.5 rounded-full border px-2 ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus ${
            working() > 0 ? "" : onRuns() ? "border-line bg-selected" : "border-transparent hover:bg-hover"
          }`}
          style={working() > 0 ? { backgroundColor: mix("leaf", 0.14), borderColor: mix("leaf", 0.45) } : undefined}
        >
          <View class="size-3 shrink-0 items-center justify-center rounded-full" style={working() > 0 ? { backgroundColor: mix("leaf", 0.25) } : undefined}>
            <View
              class={`size-1.5 rounded-full ${working() > 0 ? `bg-leaf ${motionClass("animate-pulse")}` : inbox()?.call === "live" ? "bg-leaf" : "bg-faint"}`}
            />
          </View>
          <If when={working() > 0}>
            <Text class="font-mono text-2xs font-semibold text-leaf tabular-nums">{String(working())}</Text>
          </If>
        </NavLink>
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

function Desk(props: { place?: Place | undefined }) {
  const location = useLocation();
  const teamTab = () => {
    const p = location().pathname;
    if (p.startsWith("/runtimes")) return "team-runtimes";
    if (p.startsWith("/team/skills")) return "team-skills";
    if (p.startsWith("/team/memory")) return "team-memory";
    return "team-roles";
  };
  const showContentActions = () => props.place?.id === "content" && !contentSidebarOpen.get();
  return (
    <View testID="desk" desktop={{ windowDrag: true }} class="h-9 shrink-0 flex-row items-center justify-between gap-3 border-b border-line px-3.5">
      <If when={props.place} else={<View class="flex-1" />}>
        {(place) => (
          <View class="min-w-0 flex-1 flex-row items-center gap-2.5 overflow-hidden">
            <View class="min-w-0 shrink flex-row items-center gap-2">
              <If when={place().id === "content"}>
                <IconButton
                  icon="sidebar"
                  size={16}
                  label={t("web.library.content.sidebarToggle")}
                  testid="content-sidebar-toggle"
                  pressed={contentSidebarOpen.get()}
                  onClick={() => contentSidebarOpen.update((open) => !open)}
                />
              </If>
              <View class="shrink-0">
                <Keyed key={place().icon}>{() => <Icon name={place().icon} size={16} />}</Keyed>
              </View>
              <Text role="header" class="min-w-0 truncate text-sm font-semibold text-ink">
                {place().label}
              </Text>
            </View>
            <If when={place().id === "team"}>
              <View class="h-4 w-px shrink-0 bg-line" />
              <Tabs
                look="pills"
                label={place().label}
                value={teamTab()}
                items={[
                  { value: "team-roles", label: t("web.base.tab.roles"), icon: "agents", href: "/agents" },
                  { value: "team-runtimes", label: t("web.base.tab.runtimes"), icon: "runtimes", href: "/runtimes" },
                  { value: "team-skills", label: t("web.base.tab.skills"), icon: "skill", href: "/team/skills" },
                  { value: "team-memory", label: t("web.base.tab.memory"), icon: "memory", href: "/team/memory" },
                ]}
              />
            </If>
          </View>
        )}
      </If>
      <If when={showContentActions()}>
        <View class="shrink-0 flex-row items-center gap-1.5">
          <IconButton icon="search" size={14} label={t("web.library.content.searchAll")} testid="desk-content-search" onClick={() => openContentSearch()} />
          <Button tone="primary" size="compact" icon="add" testID="desk-content-new" onPress={() => openTemplatePicker()}>
            {t("web.library.content.new")}
          </Button>
        </View>
      </If>
    </View>
  );
}

export function Shell(props: { children: JSX.Element }) {
  const matches = useMatches();
  const location = useLocation();
  const meta = () => matches().at(-1)?.meta;
  const here = () => {
    const id = meta()?.place;
    if (id === runsPlace.id) return runsPlace;
    if (id === catalogPlace.id) return catalogPlace;
    return places.find((place) => place.id === id);
  };
  const inFarm = () => meta()?.skin === "farm";
  // Ctrl+J (⌘J on a Mac) opens the channel quick switcher without colliding with global ⌘K command palette.
  keymap.bind("mod+j", () => switcher.toggle(), { when: "always" });
  return (
    <View class="flex-1 flex-row bg-page">
      <QuickSwitcher />
      <ShortcutSheet />
      <Rail here={here()} farm={inFarm()} />
      <View class="min-w-0 flex-1">
        {/* Chat draws its own top bar; native workspace fills its own pane. */}
        <If when={!inFarm() && here()?.id !== "chat" && location().pathname !== "/workspace"}>
          <Desk place={here()} />
        </If>
        <View class="min-h-0 flex-1">{props.children}</View>
      </View>
    </View>
  );
}
