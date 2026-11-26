import { colorScheme, computed, effect, host, keymap, Scroll, signal, Text, untracked, View, windowSize, type JSX, type ViewRef } from "nsh";

import { t } from "@vibevalley/i18n";
import { isFreeUserSession } from "@vibevalley/protocol/rules";

import { Button } from "../design/Button";
import { Dialog, hasOpenModal } from "../design/Dialog";
import { UserAvatar } from "../design/domain/Face";
import { Icon } from "../design/Icon";
import { OutLink } from "../design/IconButton";
import type { IconName } from "../design/icons";
import { motionClass } from "../design/motion";
import { ShortcutSheet } from "../design/ShortcutSheet";
import { Bubble } from "../design/Tip";
import { toast } from "../design/toasts";
import { mix } from "../design/tone";
import { QuickSwitcher, switcher } from "../features/channel";
import { waitingOnUser } from "../features/inbox";
import { reasonOf } from "../infra/api";
import { Keyed, variant } from "../infra/base/dom";
import { hostApi } from "../infra/bridge";
import { useInboxSlice, useLink, useSessionsSlice } from "../infra/frame";
import { clampUpdatePercent, currentHost, formatUpdateTransfer } from "../infra/host";
import { readHostParams } from "../infra/hostParams";
import { NavLink, useLocation, useMatches, useRouter } from "../infra/router";
import { useUpdates } from "../infra/settings";
import { safeLastContentPath } from "../infra/state/contentNav";
import { isVdpEnabled, useVdpNode } from "../infra/vdpProbe";
import { dashboardPlace, type Place, places, settingsPlace } from "./places";

const linkWords = { connecting: t("web.base.link.connecting"), open: t("web.base.link.open"), lost: t("web.base.link.lost") } as const;

/** Tailwind's `sm` (40rem): narrower, the rail is slimmer and its names go. */
const small = () => windowSize().width < 640;
/** Short windows (<760px tall): tighten rail vertical rhythm so all 9 nav items fit without clipping. */
const compactTall = () => windowSize().height < 760;

/** 24px icon (or the 38px farm anchor) with its short name underneath, so it reads without hovering. */
function Slot(props: { to: string; place: string; label: string; name?: string; current?: boolean; badge?: number; hero?: boolean; icon: () => JSX.Element }) {
  const router = useRouter();
  let slotRef: ViewRef | undefined;
  useVdpNode({
    testId: `place-${untracked(() => props.place)}`,
    role: "link",
    text: () => props.label,
    route: () => props.to,
    parentId: "workbench-page",
    getRef: () => slotRef,
    onPress: () => router.navigate(props.to),
  });
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
      ref={
        isVdpEnabled()
          ? (node) => {
              slotRef = node;
            }
          : undefined
      }
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

const stripVersionPrefix = (version: string) => version.replace(/^v/u, "");

function RailUpdateControl(props: { small: boolean; working: number }) {
  const updates = useUpdates();
  const router = useRouter();
  const installing = signal(false);
  const dialogOpen = signal(false);

  const readyState = computed(() => {
    const s = updates();
    return s ? variant(s, "_tag", "ready") : undefined;
  });
  const downloadingState = computed(() => {
    const s = updates();
    return s ? variant(s, "_tag", "downloading") : undefined;
  });
  const verifyingState = computed(() => {
    const s = updates();
    return s ? variant(s, "_tag", "verifying") : undefined;
  });
  const installingState = computed(() => {
    const s = updates();
    return s ? variant(s, "_tag", "installing") : undefined;
  });
  const manualState = computed(() => {
    const s = updates();
    return s ? variant(s, "_tag", "manual") : undefined;
  });

  effect(() => {
    const tag = updates()?._tag;
    if (tag !== "ready" && tag !== "installing") installing.set(false);
  });

  const doInstall = () => {
    if (untracked(installing)) return;
    const update = currentHost().update;
    if (!update) return;
    installing.set(true);
    void update.install().catch((e: unknown) => {
      installing.set(false);
      toast(reasonOf(e), "bad");
    });
  };

  const handleReadyPress = () => {
    if (!readyState() || untracked(installing)) return;
    dialogOpen.set(true);
  };

  return (
    <>
      <If when={readyState()}>
        {(r) => (
          <>
            <View
              role="button"
              testID="rail-update-btn"
              accessibilityLabel={t("web.base.updateReadyOneClick", { next: stripVersionPrefix(r().next) })}
              accessibilityState={{ busy: installing(), disabled: installing() }}
              tooltip={
                <Bubble
                  text={
                    props.working > 0
                      ? `${t("web.base.updateReadyOneClick", { next: stripVersionPrefix(r().next) })} · ${t("web.base.working", { n: props.working })}`
                      : t("web.base.updateReadyOneClick", { next: stripVersionPrefix(r().next) })
                  }
                  placement="right"
                />
              }
              onPress={handleReadyPress}
              class={`${props.small ? "size-10" : "w-15 px-1.5 py-1.5"} shrink-0 items-center justify-center gap-0.5 rounded-lg border ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus`}
              style={{ backgroundColor: mix("accent", 0.16), borderColor: mix("accent", 0.45) }}
            >
              <Icon name={installing() ? "wait" : "update"} size={18} tone="accent" />
              <If when={!props.small}>
                <Text class="w-full truncate text-center font-sans text-2xs leading-tight font-semibold text-accent">
                  {installing() ? t("web.base.updateInstalling") : t("web.base.updateInstall")}
                </Text>
              </If>
            </View>
            <Dialog
              open={dialogOpen()}
              onClose={() => dialogOpen.set(false)}
              title={t("web.base.updateReadyTitle", { next: stripVersionPrefix(r().next) })}
              testid="rail-update-confirm-dialog"
            >
              <View class="gap-3.5">
                <View class="flex-row flex-wrap items-center justify-between gap-2">
                  <View testID="rail-update-version-badge" class="rounded-sm border border-line bg-side px-2 py-0.5">
                    <Text class="font-mono text-xs text-muted tabular-nums">{`v${stripVersionPrefix(r().version)} → v${stripVersionPrefix(r().next)}`}</Text>
                  </View>
                  <If when={r().page.trim()}>{(page) => <OutLink href={page()} label={t("web.base.updateReleasePage")} />}</If>
                </View>
                <If when={props.working > 0 || r().newFarm} else={<Text class="text-sm text-muted">{t("web.base.updateReadyHint")}</Text>}>
                  <View
                    testID="rail-update-warning"
                    class="flex-row items-start gap-2 rounded-md border bg-warn-soft px-3 py-2"
                    style={{ borderColor: mix("wheat", 0.4) }}
                  >
                    <Icon name="warn" size={14} tone="wheat" />
                    <Text class="min-w-0 flex-1 text-xs leading-relaxed font-medium text-warn-ink">
                      {r().newFarm ? t("web.setting.about.newFarmQuestion") : t("web.setting.about.workingQuestion", { n: props.working })}
                    </Text>
                  </View>
                </If>
                <If when={r().notes.length > 0}>
                  <View testID="rail-update-notes" class="gap-1.5 rounded-md border border-line bg-side p-3">
                    <Text class="text-xs font-semibold text-muted">{t("web.base.updateNotesTitle")}</Text>
                    <Each of={r().notes} key={(_, i) => String(i)}>
                      {(note) => (
                        <View class="flex-row items-start gap-2">
                          <View class="mt-1.5 size-1.5 shrink-0 rounded-full bg-accent" />
                          <Text class="min-w-0 flex-1 text-xs leading-relaxed text-ink">{note()}</Text>
                        </View>
                      )}
                    </Each>
                  </View>
                </If>
                <View class="flex-row items-center justify-end gap-2">
                  <Button tone="quiet" testID="rail-update-confirm-cancel" onPress={() => dialogOpen.set(false)}>
                    {t("web.base.updateLaterOnQuit")}
                  </Button>
                  <Button
                    tone="primary"
                    icon="update"
                    testID="rail-update-confirm-sure"
                    disabled={installing()}
                    onPress={() => {
                      dialogOpen.set(false);
                      doInstall();
                    }}
                  >
                    {installing() ? t("web.base.updateInstalling") : t("web.setting.about.restart")}
                  </Button>
                </View>
              </View>
            </Dialog>
          </>
        )}
      </If>

      <If when={downloadingState()}>
        {(d) => {
          const percent = () => clampUpdatePercent(d().percent);
          const tooltipText = () => {
            const base = t("web.setting.about.downloading", { next: d().next, percent: percent() });
            const transfer = formatUpdateTransfer(d());
            return transfer ? `${base} · ${transfer}` : base;
          };
          return (
            <View
              testID="rail-update-downloading"
              accessibilityLabel={tooltipText()}
              tooltip={<Bubble text={tooltipText()} placement="right" />}
              class={`${props.small ? "size-9 px-1" : "w-15 px-1.5 py-1.5"} shrink-0 items-center justify-center gap-1 rounded-lg border border-line bg-side`}
            >
              <View class="flex-row items-center justify-center gap-1">
                <Icon name="update" size={14} tone="accent" />
                <If when={!props.small}>
                  <Text class="font-mono text-2xs font-medium text-muted tabular-nums">{`${percent()}%`}</Text>
                </If>
              </View>
              <View testID="rail-update-progress" class="h-1 w-full overflow-hidden rounded-full bg-hover">
                <View class="h-full rounded-full bg-accent" style={{ width: `${percent()}%` }} />
              </View>
            </View>
          );
        }}
      </If>

      <If when={verifyingState()}>
        {(v) => (
          <View
            testID="rail-update-verifying"
            accessibilityLabel={t("web.setting.about.verifying", { next: v().next })}
            tooltip={<Bubble text={t("web.setting.about.verifying", { next: v().next })} placement="right" />}
            class={`${props.small ? "size-9" : "w-15 px-1.5 py-1"} shrink-0 items-center justify-center gap-0.5 rounded-lg border border-line bg-side`}
          >
            <Icon name="wait" size={16} tone="water" />
            <If when={!props.small}>
              <Text class="w-full truncate text-center font-sans text-2xs leading-tight font-medium text-muted">{t("web.base.updateVerifying")}</Text>
            </If>
          </View>
        )}
      </If>

      <If when={installingState()}>
        {(inst) => (
          <View
            testID="rail-update-installing"
            accessibilityLabel={t("web.setting.about.installing", { next: inst().next })}
            accessibilityState={{ busy: true, disabled: true }}
            tooltip={<Bubble text={t("web.setting.about.installing", { next: inst().next })} placement="right" />}
            class={`${props.small ? "size-9" : "w-15 px-1.5 py-1"} shrink-0 items-center justify-center gap-0.5 rounded-lg border opacity-75`}
            style={{ backgroundColor: mix("accent", 0.12), borderColor: mix("accent", 0.35) }}
          >
            <Icon name="wait" size={16} tone="accent" />
            <If when={!props.small}>
              <Text class="w-full truncate text-center font-sans text-2xs leading-tight font-medium text-accent">{t("web.base.updateInstalling")}</Text>
            </If>
          </View>
        )}
      </If>

      <If when={manualState()}>
        {(m) => (
          <View
            role="button"
            testID="rail-update-manual"
            accessibilityLabel={t(`web.setting.about.manual.${m().why}`, { next: m().next })}
            tooltip={<Bubble text={t(`web.setting.about.manual.${m().why}`, { next: m().next })} placement="right" />}
            onPress={() => {
              const page = m().page.trim();
              if (page) void hostApi.openUrl(page);
              else router.navigate("/settings/about");
            }}
            class={`${props.small ? "size-9" : "w-15 px-1.5 py-1"} shrink-0 items-center justify-center gap-0.5 rounded-lg border ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus`}
            style={{ backgroundColor: mix("wheat", 0.16), borderColor: mix("wheat", 0.45) }}
          >
            <Icon name="update" size={16} tone="wheat" />
            <If when={!props.small}>
              <Text class="w-full truncate text-center font-sans text-2xs leading-tight font-medium text-warn-ink">{t("web.base.update")}</Text>
            </If>
          </View>
        )}
      </If>
    </>
  );
}

function Rail(props: { here?: Place | undefined; farm: boolean }) {
  const sessions = useSessionsSlice();
  const inbox = useInboxSlice();
  const link = useLink();
  const waiting = () => waitingOnUser(inbox()?.items ?? []);
  const working = () => sessions()?.sessions.filter((s) => !isFreeUserSession(s) && s.phase._tag === "working").length ?? 0;
  const atDashboard = () => props.here === dashboardPlace;
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
          to={dashboardPlace.path}
          place={dashboardPlace.id}
          label={`${dashboardPlace.label} · ${linkWords[link()]}`}
          name={dashboardPlace.label}
          current={atDashboard()}
          hero
          icon={() => (
            <View class="relative">
              <View class="overflow-hidden rounded-md border border-line">
                <UserAvatar size={38} />
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
                    const isCurrent = () =>
                      p().id === "workspace" ? location().pathname === "/workspace" || p() === props.here : p().id === "farm" ? props.farm : p() === props.here;
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
        <RailUpdateControl small={small()} working={working()} />
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
  return (
    <View testID="desk" desktop={{ windowDrag: true }} class="h-11 shrink-0 flex-row items-center justify-between gap-3 border-b border-line px-3.5">
      <If when={props.place} else={<View class="flex-1" />}>
        {(place) => (
          <View class="min-w-0 flex-1 flex-row items-center gap-2.5 overflow-hidden">
            <View class="min-w-0 shrink flex-row items-center gap-2">
              <View class="shrink-0">
                <Keyed key={place().icon}>{() => <Icon name={place().icon} size={16} />}</Keyed>
              </View>
              <Text role="header" class="min-w-0 truncate text-sm font-semibold text-ink">
                {place().label}
              </Text>
            </View>
          </View>
        )}
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
    if (id === dashboardPlace.id || id === "runs") return dashboardPlace;
    if (meta()?.skin === "farm") return places.find((place) => place.id === "farm");
    return places.find((place) => place.id === id);
  };
  const inFarm = () => meta()?.skin === "farm";
  const transparentOverlay = () => readHostParams().globalShell && hasOpenModal() && (inFarm() || location().pathname === "/workspace");
  // Ctrl+J (⌘J on a Mac) opens the channel quick switcher without colliding with global ⌘K command palette.
  keymap.bind("mod+j", () => switcher.toggle(), { when: "always" });
  return (
    <View class={transparentOverlay() ? "flex-1 flex-row bg-transparent" : "flex-1 flex-row bg-page"}>
      <QuickSwitcher />
      <ShortcutSheet />
      <Rail here={here()} farm={inFarm()} />
      <View class="min-w-0 flex-1">
        {/* Dashboard, Issues, Chat, Content, Runtimes, and Team draw their own top bars; native workspace fills its own pane. */}
        <If
          when={
            !inFarm() &&
            here()?.id !== "dashboard" &&
            here()?.id !== "issues" &&
            here()?.id !== "chat" &&
            here()?.id !== "content" &&
            here()?.id !== "runtimes" &&
            here()?.id !== "team" &&
            location().pathname !== "/workspace"
          }
        >
          <Desk place={here()} />
        </If>
        <View class="min-h-0 flex-1">{props.children}</View>
      </View>
    </View>
  );
}
