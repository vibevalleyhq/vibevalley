import { cleanup, computed, keymap, Scroll, signal, Text, View, windowSize } from "nsh";

import { t } from "@vibevalley/i18n";
import {
  type Agent,
  type InventoryEntry,
  type MachinePlatform,
  type MachineStatus,
  type McpHostId,
  type McpServerEntry,
  RuntimeCapabilityValues,
  type RuntimeInfo,
  type SessionView,
} from "@vibevalley/protocol";

import { Button } from "../../design/Button";
import { AgentFace } from "../../design/domain/Face";
import { RuntimeIcon } from "../../design/domain/RuntimeIcon";
import { SettingRow, SettingsGroup } from "../../design/domain/settings";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import type { IconName } from "../../design/icons";
import { ActiveBar, Empty, Quiet, Toggle } from "../../design/layout";
import { Splitter, usePaneWidth } from "../../design/Splitter";
import { CountPill, Dot, Tag, type DotTone, type TagTone } from "../../design/Tag";
import { Bubble } from "../../design/Tip";
import { createAct } from "../../infra/act";
import { useWorkAgents } from "../../infra/agents";
import { api, reasonOf } from "../../infra/api";
import { Keyed, variant } from "../../infra/base/dom";
import { momentText, wallClockText } from "../../infra/base/format";
import { useSessionsSlice } from "../../infra/frame";
import { ready, runtimesQuery, useQueryClient, useRuntimes } from "../../infra/query";
import { Link as A } from "../../infra/router";
import { useVdpNode } from "../../infra/vdpProbe";
import {
  buildMachineRuntimeGroups,
  type DisplayMachine,
  type MachineKind,
  machineKindOf,
  type MachineRuntimeEntry,
  type MachineRuntimeGroup,
  machinesQuery,
  resolveRuntimeSelection,
  type SelectedMachineRuntime,
  useMergedMachines,
} from "./machines";
import {
  capabilityLabel,
  InventoryCard,
  mcpEntryDescription,
  mcpHostOf,
  ModelsCard,
  RuntimeRunStatsCard,
  SettingsCard,
  SupportCard,
  Usage,
} from "./RuntimeCards";

function compactVersion(raw: string): string {
  const cleaned = raw.replace(/\s*\([^)]*\)\s*$/u, "").trim();
  const semver = /\bv?\d+\.\d+(?:\.\d+)?(?:-[\w.-]+)?\b/u.exec(cleaned);
  return semver ? semver[0] : cleaned;
}

const statusOf = (entry: MachineRuntimeEntry): string => {
  const r = entry.info;
  if (!r) return t("web.runtime.available");
  const i = r.installation;
  switch (i.status) {
    case "available":
      return r.settings.enabled ? (i.version ?? t("web.runtime.available")) : t("web.runtime.disabled");
    case "unsupported":
      return i.signInCommand ? t("web.runtime.quota.signedOut") : i.reason || t("web.runtime.unsupported");
    case "not_found":
      return t("web.runtime.notFound");
    case "checking":
      return t("web.runtime.checking");
  }
};

const compactStatusOf = (entry: MachineRuntimeEntry): string => {
  const r = entry.info;
  if (r?.installation.status === "available" && r.settings.enabled && r.installation.version) {
    return compactVersion(r.installation.version);
  }
  return statusOf(entry);
};

type HeroStatus = { readonly label: string; readonly box: string; readonly text: string; readonly dot: DotTone };

function heroStatusOf(entry: MachineRuntimeEntry): HeroStatus {
  const r = entry.info;
  if (!r) {
    return { label: t("web.runtime.available"), box: "bg-ok-soft", text: "text-ok-ink", dot: "leaf" };
  }
  const i = r.installation;
  switch (i.status) {
    case "available":
      return r.settings.enabled
        ? { label: t("web.runtime.available"), box: "bg-ok-soft", text: "text-ok-ink", dot: "leaf" }
        : { label: t("web.runtime.disabled"), box: "bg-hover", text: "text-muted", dot: "faint" };
    case "unsupported":
      return i.signInCommand
        ? { label: t("web.runtime.quota.signedOut"), box: "bg-warn-soft", text: "text-warn-ink", dot: "wheat" }
        : { label: t("web.runtime.unsupported"), box: "bg-bad-soft", text: "text-berry", dot: "berry" };
    case "not_found":
      return { label: t("web.runtime.notFound"), box: "bg-bad-soft", text: "text-berry", dot: "berry" };
    case "checking":
      return { label: t("web.runtime.checking"), box: "bg-hover", text: "text-muted", dot: "water" };
  }
}

const statusDotClass = (entry: MachineRuntimeEntry): string => {
  if (!entry.info) return "bg-leaf";
  if (entry.info.installation.status === "available") return entry.info.settings.enabled ? "bg-leaf" : "bg-faint";
  if (entry.info.installation.status === "unsupported" && entry.info.installation.signInCommand) return "bg-wheat";
  return "bg-berry";
};

/** The folder of an absolute command, where a terminal for the runtime opens. */
const folderOf = (command: string) => (command.startsWith("/") ? command.slice(0, command.lastIndexOf("/")) || "/" : undefined);

const runtimeHref = (machineId: string, runtimeId: string) => `/runtimes/${encodeURIComponent(machineId)}/${encodeURIComponent(runtimeId)}`;

const md = () => windowSize().width >= 768;
const lg = () => windowSize().width >= 1024;

function machineKindMeta(kind: MachineKind): { readonly label: string; readonly tone: TagTone; readonly icon: IconName } {
  switch (kind) {
    case "local":
      return { label: t("web.runtime.machines.kind.local"), tone: "ok", icon: "runtimes" };
    case "remote":
      return { label: t("web.runtime.machines.kind.remote"), tone: "info", icon: "web" };
    case "sandbox":
      return { label: t("web.runtime.machines.kind.sandbox"), tone: "wait", icon: "lock" };
  }
}

function platformMeta(platform: MachinePlatform): { readonly label: string; readonly icon: IconName } {
  switch (platform) {
    case "macos":
      return { label: t("web.runtime.machines.platform.macos"), icon: "devices" };
    case "linux":
      return { label: t("web.runtime.machines.platform.linux"), icon: "terminal" };
    case "container":
      return { label: t("web.runtime.machines.platform.container"), icon: "lock" };
    case "other":
      return { label: t("web.runtime.machines.platform.other"), icon: "devices" };
  }
}

function machineStatusMeta(status: MachineStatus): { readonly label: string; readonly dot: DotTone } {
  switch (status) {
    case "online":
      return { label: t("web.runtime.machines.status.online"), dot: "leaf" };
    case "offline":
      return { label: t("web.runtime.machines.status.offline"), dot: "berry" };
    case "draining":
      return { label: t("web.runtime.machines.status.draining"), dot: "wheat" };
  }
}

function matchesSessionForEntry(session: SessionView, machine: DisplayMachine, entry: MachineRuntimeEntry): boolean {
  if (session.runtime !== entry.runtimeId) return false;
  if (machine.here) return session.machine === undefined || session.machine === "" || session.machine === "local" || session.machine === machine.id;
  return session.machine === machine.id;
}

function matchesAgentForEntry(agent: Agent, machine: DisplayMachine, entry: MachineRuntimeEntry): boolean {
  if (agent.runtime === `${machine.id}/${entry.runtimeId}`) return true;
  return machine.here && agent.runtime === entry.runtimeId;
}

/** `rest` is the path after /runtimes/ (`<machine>/<runtime>`). */
export function RuntimesPage(props: { rest: string }) {
  useVdpNode({ testId: "runtimes-page", role: "region" });
  const client = useQueryClient();
  const runtimes = useRuntimes();
  const agents = useWorkAgents();
  const sessions = useSessionsSlice();
  const machines = useMergedMachines();

  const sidebarOpen = signal(true);
  const inspectorOpen = signal(false);
  const inspectorWidth = usePaneWidth("runtime-inspector", 304, 248, 420);
  const refreshingAll = createAct();
  const refreshingOne = createAct();

  cleanup(keymap.bind("mod+\\", () => sidebarOpen.set(!sidebarOpen()), { when: "always" }));

  const groups = computed(() => buildMachineRuntimeGroups(machines(), ready(runtimes, []), t("web.runtime.machines.kind.local")));
  const totalInstalled = computed(() => groups().reduce((sum, g) => sum + g.runtimes.length, 0));
  const selected = computed(() => resolveRuntimeSelection(groups(), props.rest));
  const loading = computed(() => runtimes.status() === "pending" && totalInstalled() === 0);

  const agentsByRuntimeKey = computed(() => {
    const map = new Map<string, Agent[]>();
    const list = agents();
    for (const g of groups()) {
      for (const e of g.runtimes) {
        map.set(
          e.key,
          list.filter((a) => matchesAgentForEntry(a, g.machine, e)),
        );
      }
    }
    return map;
  });

  const sessionsForSelected = computed((): SessionView[] => {
    const sel = selected();
    if (!sel) return [];
    return (sessions()?.sessions ?? []).filter((s) => matchesSessionForEntry(s, sel.machine, sel.entry));
  });

  const keepRuntime = (got: RuntimeInfo) =>
    client.setData(runtimesQuery(), (all) => (all ? { value: all.value.map((r) => (r.id === got.id ? got : r)) } : undefined));

  const syncMcpServers = (host: McpHostId, servers: readonly McpServerEntry[]) => {
    const entries: InventoryEntry[] = servers.map((s) => ({
      name: s.name,
      description: mcpEntryDescription(s),
      source: s.configPath,
      enabled: s.enabled,
    }));
    client.setData(runtimesQuery(), (all) =>
      all ? { value: all.value.map((r) => (mcpHostOf(r.id) === host ? { ...r, mcpServers: entries } : r)) } : undefined,
    );
  };

  const refreshAll = () =>
    refreshingAll.run(async () => {
      await Promise.all([client.invalidate(runtimesQuery()), client.invalidate(machinesQuery())]);
    });

  const recheckOne = (id: string) => refreshingOne.run(async () => keepRuntime(await api.runtime.refresh({ id })));

  return (
    <If
      when={!runtimes.error()}
      else={
        <View testID="runtimes-page" class="h-full flex-1 bg-page p-8">
          <Text class="text-sm text-berry">
            {t("web.runtime.noRuntimes")}
            {reasonOf(runtimes.error())}
          </Text>
        </View>
      }
    >
      <View testID="runtimes-page" class="relative h-full min-h-0 min-w-0 flex-1 flex-row overflow-hidden bg-page">
        {/* Left rail: machine-grouped installed coding engines */}
        <If when={sidebarOpen() && md()}>
          <RuntimesSidebar
            groups={groups()}
            total={totalInstalled()}
            loading={loading()}
            selectedKey={selected()?.entry.key}
            agentsByKey={agentsByRuntimeKey()}
            refreshBusy={refreshingAll.busy()}
            onCollapse={() => sidebarOpen.set(false)}
            onRefreshAll={() => void refreshAll()}
          />
        </If>
        <If when={sidebarOpen() && !md()}>
          <View class="absolute inset-0 z-30">
            <View class="absolute inset-0 bg-scrim" onPress={() => sidebarOpen.set(false)} />
            <View class="absolute top-0 bottom-0 left-0 w-64 shadow-float">
              <RuntimesSidebar
                groups={groups()}
                total={totalInstalled()}
                loading={loading()}
                selectedKey={selected()?.entry.key}
                agentsByKey={agentsByRuntimeKey()}
                refreshBusy={refreshingAll.busy()}
                onCollapse={() => sidebarOpen.set(false)}
                onRefreshAll={() => void refreshAll()}
              />
            </View>
          </View>
        </If>

        {/* Middle column: selected engine detail workspace */}
        <View testID="runtimes-main" class="min-h-0 min-w-0 flex-1 bg-page">
          <View testID="runtimes-main-head" desktop={{ windowDrag: true }} class="h-11 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-4">
            <If when={!sidebarOpen()}>
              <IconButton
                icon="sidebar"
                size={16}
                label={t("web.runtime.sidebarToggle")}
                testid="runtimes-sidebar-expand"
                pressed={false}
                onClick={() => sidebarOpen.set(true)}
              />
            </If>
            <If
              when={selected()}
              else={
                <View class="min-w-0 flex-1">
                  <Text role="header" class="truncate text-sm font-semibold text-ink">
                    {t("web.base.place.runtimes.label")}
                  </Text>
                </View>
              }
            >
              {(sel) => (
                <View class="min-w-0 flex-1 flex-row items-center gap-2 overflow-hidden">
                  <RuntimeIcon runtime={sel().entry.runtimeId} size={18} />
                  <Text testID="runtime-header-title" role="header" class="min-w-0 shrink truncate text-sm font-semibold text-ink">
                    {sel().entry.label}
                  </Text>
                  <View testID="selected-machine-pill" class="h-5 shrink-0 flex-row items-center gap-1.5 rounded-full border border-line bg-side px-2">
                    <Dot tone={machineStatusMeta(sel().machine.status).dot} size={6} ring={false} />
                    <Text class="max-w-36 truncate text-2xs font-medium text-muted">{sel().machine.name}</Text>
                  </View>
                </View>
              )}
            </If>
            <View class="shrink-0 flex-row items-center gap-1">
              <If
                when={selected()?.entry.info}
                else={
                  <IconButton
                    icon="refresh"
                    size={16}
                    label={t("web.runtime.refreshAll")}
                    testid="runtime-recheck"
                    disabled={refreshingAll.busy()}
                    onClick={() => void refreshAll()}
                  />
                }
              >
                {(info) => (
                  <IconButton
                    icon="refresh"
                    size={16}
                    label={refreshingOne.busy() ? t("web.runtime.checking") : t("web.runtime.recheck")}
                    testid="runtime-recheck"
                    disabled={refreshingOne.busy()}
                    onClick={() => void recheckOne(info().id)}
                  />
                )}
              </If>
              <IconButton
                icon="sidebarRight"
                size={16}
                label={inspectorOpen() ? t("web.runtime.inspectorHide") : t("web.runtime.inspectorShow")}
                testid="runtimes-inspector-toggle"
                pressed={inspectorOpen()}
                onClick={() => inspectorOpen.set(!inspectorOpen())}
              />
            </View>
          </View>

          <Scroll class="min-h-0 flex-1" contentClass={md() ? "px-8 py-6 pb-10" : "px-5 py-5 pb-8"}>
            <If
              when={selected()}
              else={
                <If when={loading()} else={<EmptyInstalled onRefresh={() => void refreshAll()} busy={refreshingAll.busy()} />}>
                  <Quiet>{t("web.runtime.reading")}</Quiet>
                </If>
              }
            >
              {(sel) => (
                <Keyed key={sel().entry.key}>
                  {() => (
                    <RuntimeWorkspace
                      selected={sel()}
                      agents={agentsByRuntimeKey().get(sel().entry.key) ?? []}
                      sessions={sessionsForSelected()}
                      onSaved={keepRuntime}
                    />
                  )}
                </Keyed>
              )}
            </If>
          </Scroll>
        </View>

        {/* Right column: collapsible & resizable machine + runtime inspector */}
        <If when={inspectorOpen()}>
          <View
            testID="runtimes-inspector"
            accessibilityLabel={t("web.runtime.inspectorTitle")}
            class={`h-full min-h-0 border-l border-line bg-side ${lg() ? "relative shrink-0" : "absolute inset-0 z-20"}`}
            style={lg() ? { width: inspectorWidth() } : undefined}
          >
            <If when={lg()}>
              <Splitter pane="runtime-inspector" side="left" width={inspectorWidth()} min={248} max={420} label={t("web.runtime.inspectorTitle")} />
            </If>
            <View
              testID="runtimes-inspector-head"
              desktop={{ windowDrag: true }}
              class="h-11 shrink-0 flex-row items-center justify-between gap-2 border-b border-line px-3.5"
            >
              <Text role="header" class="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
                {t("web.runtime.inspectorTitle")}
              </Text>
              <IconButton
                icon="close"
                size={14}
                label={t("web.runtime.inspectorHide")}
                testid="runtimes-inspector-close"
                onClick={() => inspectorOpen.set(false)}
              />
            </View>
            <Scroll class="min-h-0 flex-1" contentClass="gap-4 p-3.5 pb-6">
              <If when={selected()} else={<Quiet>{t("web.runtime.noneInstalled")}</Quiet>}>
                {(sel) => (
                  <RuntimeInspector
                    selected={sel()}
                    groupCount={groups().find((g) => g.machine.id === sel().machine.id)?.runtimes.length ?? 0}
                    recheckBusy={refreshingOne.busy() || refreshingAll.busy()}
                    onRecheck={() => {
                      const info = sel().entry.info;
                      if (info) void recheckOne(info.id);
                      else void refreshAll();
                    }}
                    onMcpServersSynced={syncMcpServers}
                  />
                )}
              </If>
            </Scroll>
          </View>
        </If>
      </View>
    </If>
  );
}

function RuntimesSidebar(props: {
  groups: readonly MachineRuntimeGroup[];
  total: number;
  loading: boolean;
  selectedKey?: string | undefined;
  agentsByKey: ReadonlyMap<string, Agent[]>;
  refreshBusy: boolean;
  onCollapse: () => void;
  onRefreshAll: () => void;
}) {
  return (
    <View testID="runtimes-sidebar" accessibilityLabel={t("web.base.place.runtimes.label")} class="h-full w-64 shrink-0 border-r border-line bg-side">
      <View testID="runtimes-sidebar-head" desktop={{ windowDrag: true }} class="h-11 shrink-0 flex-row items-center gap-1.5 border-b border-line px-3">
        <IconButton
          icon="sidebar"
          size={16}
          label={t("web.runtime.sidebarToggle")}
          testid="runtimes-sidebar-toggle"
          pressed
          onClick={() => props.onCollapse()}
        />
        <Text role="header" class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
          {t("web.base.place.runtimes.label")}
        </Text>
        <If when={props.total > 0}>
          <CountPill count={props.total} />
        </If>
        <IconButton
          icon="refresh"
          size={14}
          label={t("web.runtime.refreshAll")}
          testid="runtimes-refresh-all"
          disabled={props.refreshBusy}
          onClick={() => props.onRefreshAll()}
        />
      </View>

      <Scroll testID="runtimes" class="min-h-0 flex-1" contentClass="gap-2 px-2.5 py-2 pb-6">
        <If
          when={props.groups.length > 0}
          else={
            <If
              when={props.loading}
              else={
                <Text testID="runtimes-sidebar-empty" class="px-2.5 py-3 text-xs text-muted">
                  {t("web.runtime.noneInstalled")}
                </Text>
              }
            >
              <Text class="px-2.5 py-3 text-xs text-muted">{t("web.runtime.reading")}</Text>
            </If>
          }
        >
          <Each of={props.groups} key={(g) => g.machine.id}>
            {(group) => {
              const kind = () => machineKindMeta(machineKindOf(group().machine));
              const state = () => machineStatusMeta(group().machine.status);
              return (
                <View testID={`machine-group-${group().machine.id}`} class="gap-0.5">
                  <View class="flex-row items-center gap-1.5 px-2.5 pt-2.5 pb-1">
                    <Dot tone={state().dot} size={6} ring={false} />
                    <Text class="min-w-0 flex-1 truncate text-2xs font-semibold text-faint">{group().machine.name}</Text>
                    <View class="rounded-full bg-hover px-1.5 py-px">
                      <Text class="text-2xs text-faint">{kind().label}</Text>
                    </View>
                  </View>
                  <View class="gap-0.5">
                    <Each of={group().runtimes} key={(e) => e.key}>
                      {(entry) => {
                        const active = () => props.selectedKey === entry().key;
                        const using = () => props.agentsByKey.get(entry().key)?.length ?? 0;
                        const tipText = () => `${entry().label} · ${statusOf(entry())}${using() > 0 ? t("web.runtime.usedBy", { n: using() }) : ""}`;
                        return (
                          <A
                            href={runtimeHref(entry().machineId, entry().runtimeId)}
                            testID={`runtime-row-${entry().machineId}-${entry().runtimeId}`}
                            accessibilityLabel={`${entry().label} · ${group().machine.name}`}
                            accessibilityState={{ selected: active() }}
                            tooltip={<Bubble text={tipText()} />}
                            class={`relative group h-10 flex-row items-center gap-2.5 rounded-md px-2.5 focus-visible:outline-2 focus-visible:outline-focus ${
                              active() ? "bg-selected" : "hover:bg-hover"
                            }`}
                          >
                            <If when={active()}>
                              <ActiveBar />
                            </If>
                            <RuntimeIcon runtime={entry().runtimeId} size={18} />
                            <Text class={`min-w-20 flex-1 truncate text-sm font-medium ${active() ? "text-ink" : "text-muted group-hover:text-ink"}`}>
                              {entry().label}
                            </Text>
                            <View class="min-w-0 shrink-0 flex-row items-center justify-end gap-1.5">
                              <Text class="max-w-16 truncate font-mono text-2xs tabular-nums text-faint">{compactStatusOf(entry())}</Text>
                              <View class={`h-2 w-2 shrink-0 rounded-full ${statusDotClass(entry())}`} />
                            </View>
                          </A>
                        );
                      }}
                    </Each>
                  </View>
                </View>
              );
            }}
          </Each>
        </If>
      </Scroll>
    </View>
  );
}

function EmptyInstalled(props: { onRefresh: () => void; busy: boolean }) {
  return (
    <Empty
      icon="runtimes"
      testid="runtimes-empty"
      action={
        <Button icon="refresh" disabled={props.busy} onPress={() => props.onRefresh()}>
          {props.busy ? t("web.runtime.checking") : t("web.runtime.recheck")}
        </Button>
      }
    >
      {t("web.runtime.noneInstalledHint")}
    </Empty>
  );
}

function RuntimeWorkspace(props: {
  selected: SelectedMachineRuntime;
  agents: readonly Agent[];
  sessions: readonly SessionView[];
  onSaved: (got: RuntimeInfo) => void;
}) {
  const info = () => props.selected.entry.info;
  const machine = () => props.selected.machine;
  const entry = () => props.selected.entry;
  const inst = () => info()?.installation;
  const hero = () => heroStatusOf(entry());
  const toggling = createAct();

  const terminalDirectory = () => {
    const i = inst();
    if (!i) return undefined;
    if (i.status === "available") return folderOf(i.command);
    return i.status === "unsupported" && i.signInCommand ? folderOf(i.signInCommand) : undefined;
  };
  const remoteModels = computed(() => entry().summary?.models ?? []);

  const toggleEnabled = (localInfo: RuntimeInfo, enabled: boolean) => {
    const id = localInfo.id;
    const settings = localInfo.settings;
    return toggling.run(async () => props.onSaved(await api.runtime.setting.update({ id, ...settings, enabled })));
  };

  const checkedAtHint = () => {
    const at = info()?.checkedAt;
    return at !== undefined && at > 0 ? t("web.runtime.checkedAt", { clock: wallClockText(at) }) : undefined;
  };

  return (
    <View testID="runtime-detail" class="w-full max-w-195 gap-6">
      {/* Linear hero header */}
      <View class="flex-row items-start justify-between gap-4">
        <View class="min-w-0 flex-1 flex-row items-start gap-3.5">
          <View class="size-10 shrink-0 items-center justify-center rounded-xl border border-line bg-elevated">
            <RuntimeIcon runtime={entry().runtimeId} size={32} />
          </View>
          <View class="min-w-0 flex-1 gap-1">
            <View class="flex-row flex-wrap items-center gap-2">
              <Text role="header" class="text-xl font-semibold text-ink">
                {entry().label}
              </Text>
              <View class={`h-5 shrink-0 flex-row items-center gap-1.5 rounded-full px-2 ${hero().box}`}>
                <Dot tone={hero().dot} size={6} ring={false} />
                <Text class={`text-2xs font-medium ${hero().text}`}>{hero().label}</Text>
              </View>
            </View>
            <If
              when={info()?.preset.blurb}
              else={<Text class="text-xs leading-relaxed text-muted">{t("web.runtime.remoteSummary", { machine: machine().name })}</Text>}
            >
              {(blurb) => <Text class="text-xs leading-relaxed text-muted">{blurb()}</Text>}
            </If>
          </View>
        </View>
        <View class="shrink-0 flex-row items-center gap-2 pt-1">
          <If
            when={info()}
            else={<Tag icon={machineKindMeta(machineKindOf(machine())).icon} tone={machineKindMeta(machineKindOf(machine())).tone} label={machine().name} />}
          >
            {(localInfo) => (
              <View tooltip={<Bubble text={t("web.runtime.enabledHint")} />} class="flex-row items-center gap-2">
                <Text class="text-xs text-muted">{t("web.runtime.enabled")}</Text>
                <Toggle
                  bare
                  ariaLabel={t("web.runtime.enabled")}
                  checked={localInfo().settings.enabled}
                  disabled={toggling.busy()}
                  onChange={(enabled) => void toggleEnabled(localInfo(), enabled)}
                />
              </View>
            )}
          </If>
        </View>
      </View>

      {/* Overview / Installation card (non-available states only; available path is merged into Settings) */}
      <If when={inst() && inst()?.status !== "available" ? inst() : undefined}>
        {(i) => (
          <SettingsGroup title={t("web.runtime.installation")} note={machine().name}>
            <If when={variant(i(), "status", "unsupported")}>
              {(unsup) => (
                <SettingRow label={t("web.runtime.installation")} hint={checkedAtHint()} last>
                  <If
                    when={unsup().signInCommand}
                    else={
                      <View class="rounded-full bg-bad-soft px-2 py-0.5">
                        <Text class="text-xs font-medium text-berry">{t("web.runtime.unsupportedWhy", { why: unsup().reason })}</Text>
                      </View>
                    }
                  >
                    {(command) => (
                      <>
                        <View tooltip={<Bubble text={command()} />} class="max-w-72 rounded-md border border-line bg-side px-2 py-0.5">
                          <Text class="truncate font-mono text-xs text-muted">{command()}</Text>
                        </View>
                        <View class="rounded-full bg-warn-soft px-2 py-0.5">
                          <Text class="text-2xs font-medium text-warn-ink">{t("web.runtime.quota.signedOut")}</Text>
                        </View>
                      </>
                    )}
                  </If>
                </SettingRow>
              )}
            </If>
            <If when={i().status === "not_found" || i().status === "checking"}>
              <SettingRow label={t("web.runtime.installation")} hint={checkedAtHint()} last>
                <Text class="text-xs text-muted">{i().status === "checking" ? t("web.runtime.checking") : t("web.runtime.notFound")}</Text>
              </SettingRow>
            </If>
          </SettingsGroup>
        )}
      </If>

      <If when={info()}>
        {(localInfo) => (
          <>
            <SettingsGroup title={t("web.runtime.account")}>
              <Usage info={localInfo()} terminalDirectory={terminalDirectory()} />
            </SettingsGroup>
            <SettingsCard info={localInfo()} onSaved={(got) => props.onSaved(got)} pathRef={() => {}} />
            <ModelsCard info={localInfo()} />
          </>
        )}
      </If>

      <If when={!info()}>
        <SettingsGroup title={t("web.runtime.models")} note={remoteModels().length > 0 ? t("web.runtime.modelCount", { n: remoteModels().length }) : undefined}>
          <If
            when={remoteModels().length > 0}
            else={
              <View class="px-4 py-3.5">
                <Quiet>{t("web.runtime.noModels")}</Quiet>
              </View>
            }
          >
            <Each of={remoteModels()} key={(m) => m.id}>
              {(m, i) => (
                <View
                  class={`min-h-11 flex-row items-center justify-between gap-4 px-4 py-2.5 ${i() === remoteModels().length - 1 ? "" : "border-b border-line"}`}
                >
                  <View class="min-w-0 flex-1 flex-row items-center gap-2">
                    <Text class="truncate font-mono text-xs text-ink">{m().id}</Text>
                    <If when={m().isDefault}>
                      <View class="shrink-0 rounded-full bg-ok-soft px-2 py-px">
                        <Text class="text-2xs font-medium text-ok-ink">{t("web.runtime.default")}</Text>
                      </View>
                    </If>
                  </View>
                  <Text class="shrink-0 text-xs text-muted">{m().effortLevels.join(" · ") || "—"}</Text>
                </View>
              )}
            </Each>
          </If>
        </SettingsGroup>
      </If>

      <SettingsGroup
        title={t("web.runtime.agents")}
        action={
          <A
            href={`/agents/new?runtime=${encodeURIComponent(entry().runtimeId)}`}
            testID="new-agent"
            class="group flex-row items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-hover"
          >
            <Text class="text-xs font-medium text-muted group-hover:text-ink">{t("web.runtime.makeAgent")}</Text>
            <Icon name="next" size={12} tone="muted" />
          </A>
        }
      >
        <If
          when={props.agents.length > 0}
          else={
            <View class="px-4 py-3.5">
              <Quiet>{t("web.runtime.noneYet")}</Quiet>
            </View>
          }
        >
          <Each of={props.agents} key={(a) => a.id}>
            {(a, i) => (
              <A
                href={`/agents/${encodeURIComponent(a().id)}`}
                class={`min-h-12 flex-row items-center gap-3 px-4 py-2.5 hover:bg-hover ${i() === props.agents.length - 1 ? "" : "border-b border-line"}`}
              >
                <View class="size-7 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-side">
                  <AgentFace agentId={a().id} name={a().name} runtime={a().runtime} look={a().look} size={24} />
                </View>
                <View class="min-w-0 flex-1 gap-0.5">
                  <Text class="truncate text-sm font-medium text-ink">{a().name}</Text>
                  <If when={a().duty}>{(duty) => <Text class="truncate text-xs text-muted">{duty()}</Text>}</If>
                </View>
                <Icon name="next" size={14} tone="faint" />
              </A>
            )}
          </Each>
        </If>
      </SettingsGroup>

      <RuntimeRunStatsCard sessions={props.sessions} />

      <SettingsGroup title={t("web.runtime.sessions")} note={props.sessions.length > 0 ? String(props.sessions.length) : undefined}>
        <If
          when={props.sessions.length > 0}
          else={
            <View class="px-4 py-3.5">
              <Quiet>{t("web.runtime.noSessions")}</Quiet>
            </View>
          }
        >
          <Each of={props.sessions.slice(0, 6)} key={(s) => s.id}>
            {(s, i) => (
              <A
                href={`/runs?session=${encodeURIComponent(s().id)}`}
                testID={`runtime-session-${s().id}`}
                class={`min-h-11 flex-row items-center gap-2.5 px-4 py-2.5 hover:bg-hover ${
                  i() === Math.min(props.sessions.length, 6) - 1 ? "" : "border-b border-line"
                }`}
              >
                <Dot tone={s().phase._tag === "working" ? "leaf" : s().phase._tag === "failed" ? "berry" : "faint"} size={6} ring={false} />
                <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{s().name || s().brief || s().id}</Text>
                <Text class="shrink-0 text-2xs text-muted">{s().phaseText}</Text>
                <Icon name="next" size={12} tone="faint" />
              </A>
            )}
          </Each>
        </If>
      </SettingsGroup>
    </View>
  );
}

function InspectorRow(props: { label: string; value: string; mono?: boolean; last?: boolean }) {
  return (
    <View class={`flex-row items-center justify-between gap-3 px-3.5 py-2 ${props.last === true ? "" : "border-b border-line"}`}>
      <Text class="shrink-0 text-xs text-muted">{props.label}</Text>
      <Text class={`min-w-0 truncate text-right text-xs text-ink ${props.mono === true ? "font-mono tabular-nums" : ""}`}>{props.value}</Text>
    </View>
  );
}

function RuntimeInspector(props: {
  selected: SelectedMachineRuntime;
  groupCount: number;
  recheckBusy: boolean;
  onRecheck: () => void;
  onMcpServersSynced: (host: McpHostId, servers: readonly McpServerEntry[]) => void;
}) {
  const machine = () => props.selected.machine;
  const entry = () => props.selected.entry;
  const kind = () => machineKindMeta(machineKindOf(machine()));
  const plat = () => platformMeta(machine().platform);
  const state = () => machineStatusMeta(machine().status);
  const remoteCaps = computed(() => new Set(entry().summary?.capabilities ?? []));
  const hasLastSeen = () => (machine().lastSeenAt ?? machine().joinedAt) !== undefined;

  return (
    <>
      <SettingsGroup title={t("web.runtime.machines.title")} testid={`inspector-machine-${machine().id}`}>
        <View class="gap-2 border-b border-line px-3.5 py-3">
          <View class="flex-row items-center justify-between gap-2">
            <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{machine().name}</Text>
            <View class="shrink-0 flex-row items-center gap-1.5 rounded-full bg-hover px-2 py-0.5">
              <Dot tone={state().dot} size={6} ring={false} />
              <Text testID={`machine-status-${machine().id}`} class="text-2xs font-medium text-muted">
                {state().label}
              </Text>
            </View>
          </View>
          <View class="flex-row flex-wrap items-center gap-1.5">
            <Tag icon={kind().icon} tone={kind().tone} label={kind().label} />
            <Tag icon={plat().icon} tone="neutral" label={plat().label} />
          </View>
        </View>
        <InspectorRow label={t("web.runtime.machines.machineId")} value={machine().id} mono />
        <InspectorRow label={t("web.runtime.machines.installedCount")} value={String(props.groupCount)} mono last={!hasLastSeen()} />
        <If when={machine().lastSeenAt ?? machine().joinedAt}>
          {(ts) => <InspectorRow label={t("web.runtime.machines.lastSeen")} value={momentText(ts())} last />}
        </If>
      </SettingsGroup>

      <If
        when={entry().info}
        else={
          <SettingsGroup title={t("web.runtime.can")}>
            <View class="flex-row flex-wrap gap-1.5 px-3.5 py-3">
              <Each of={RuntimeCapabilityValues} key={(c) => c}>
                {(c) => (
                  <View class={`rounded-md px-2 py-0.5 ${remoteCaps().has(c()) ? "bg-selected" : "bg-hover"}`}>
                    <Text class={`text-xs ${remoteCaps().has(c()) ? "font-medium text-ink" : "text-faint line-through"}`}>{capabilityLabel[c()]}</Text>
                  </View>
                )}
              </Each>
            </View>
          </SettingsGroup>
        }
      >
        {(info) => (
          <>
            <SupportCard info={info()} />
            <InventoryCard
              title={t("web.runtime.mcp")}
              entries={info().mcpServers}
              mcpHost={machine().here ? mcpHostOf(info().id) : undefined}
              onMcpServersSynced={props.onMcpServersSynced}
            />
            <If when={(info().skills?.length ?? 0) > 0}>
              <InventoryCard title={t("web.runtime.skills")} entries={info().skills} />
            </If>
            <If when={(info().tools?.length ?? 0) > 0}>
              <InventoryCard title={t("web.runtime.tools")} entries={info().tools} />
            </If>
          </>
        )}
      </If>

      <SettingsGroup title={t("web.runtime.quickActions")}>
        <View class="flex-row flex-wrap gap-2 px-3.5 py-3">
          <Button size="compact" icon="refresh" disabled={props.recheckBusy} onPress={() => props.onRecheck()}>
            {props.recheckBusy ? t("web.runtime.checking") : t("web.runtime.recheck")}
          </Button>
        </View>
      </SettingsGroup>
    </>
  );
}
