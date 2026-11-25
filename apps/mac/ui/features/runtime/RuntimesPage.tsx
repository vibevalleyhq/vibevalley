import { computed, keymap, Scroll, signal, Text, View, windowSize } from "nsh";

import { t } from "@vibevalley/i18n";
import { type Agent, type MachinePlatform, type MachineStatus, RuntimeCapabilityValues, type RuntimeInfo, type SessionView } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button } from "../../design/Button";
import { AgentFace } from "../../design/domain/Face";
import { OpenTerminal } from "../../design/domain/OpenTerminal";
import { RuntimeIcon } from "../../design/domain/RuntimeIcon";
import { Icon } from "../../design/Icon";
import { IconButton } from "../../design/IconButton";
import type { IconName } from "../../design/icons";
import { ActiveBar, Card, Empty, Quiet } from "../../design/layout";
import { Splitter, usePaneWidth } from "../../design/Splitter";
import { CountPill, Dot, Tag, type DotTone, type TagTone } from "../../design/Tag";
import { Bubble } from "../../design/Tip";
import { useWorkAgents } from "../../infra/agents";
import { api, reasonOf } from "../../infra/api";
import { Keyed, variant } from "../../infra/base/dom";
import { momentText, wallClockText } from "../../infra/base/format";
import { useSessionsSlice } from "../../infra/frame";
import { ready, runtimesQuery, useQueryClient, useRuntimes } from "../../infra/query";
import { Link as A } from "../../infra/router";
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
import { quotaOf } from "./quota";
import { capabilityLabel, InventoryCard, ModelsCard, SettingsCard, Stamina, SupportCard, Usage } from "./RuntimeCards";

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

const statusDotClass = (entry: MachineRuntimeEntry): string => {
  if (!entry.info) return "bg-leaf";
  if (entry.info.installation.status === "available") return entry.info.settings.enabled ? "bg-leaf" : "bg-faint";
  if (entry.info.installation.status === "unsupported" && entry.info.installation.signInCommand) return "bg-wheat";
  return "bg-berry";
};

const availableVersion = (entry: MachineRuntimeEntry): string | undefined => {
  const inst = entry.info?.installation;
  return inst?.status === "available" ? (inst.version ?? undefined) : undefined;
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

/** `rest` is the path after /runtimes/ (`<machine>/<runtime>` or legacy `<runtime>`). */
export function RuntimesPage(props: { rest: string }) {
  const client = useQueryClient();
  const runtimes = useRuntimes();
  const agents = useWorkAgents();
  const sessions = useSessionsSlice();
  const machines = useMergedMachines();

  const sidebarOpen = signal(true);
  const inspectorOpen = signal(true);
  const inspectorWidth = usePaneWidth("runtime-inspector", 308, 248, 440);
  const refreshingAll = createAct();
  const refreshingOne = createAct();

  keymap.bind("mod+\\", () => sidebarOpen.set(!sidebarOpen()), { when: "always" });

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
        {/* Left column: machine-grouped installed coding engines */}
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
          <View testID="runtimes-main-head" desktop={{ windowDrag: true }} class="h-9 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-3">
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
                  <RuntimeIcon runtime={sel().entry.runtimeId} size={20} />
                  <Text testID="runtime-header-title" role="header" class="min-w-0 shrink truncate text-sm font-semibold text-ink">
                    {sel().entry.label}
                  </Text>
                  <View testID="selected-machine-pill" class="h-5 shrink-0 flex-row items-center gap-1.5 rounded-sm border border-line bg-side px-1.5">
                    <Dot tone={machineStatusMeta(sel().machine.status).dot} size={6} ring={false} />
                    <Text class="max-w-36 truncate text-2xs font-medium text-muted">{sel().machine.name}</Text>
                  </View>
                  <If when={availableVersion(sel().entry)}>
                    {(version) => (
                      <View class="h-5 shrink-0 items-center justify-center rounded-sm bg-ok-soft px-1.5">
                        <Text class="font-mono text-2xs font-medium text-ok-ink tabular-nums">{version()}</Text>
                      </View>
                    )}
                  </If>
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

          <Scroll class="min-h-0 flex-1" contentClass="gap-4 p-5 pb-8">
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
              <Splitter pane="runtime-inspector" side="left" width={inspectorWidth()} min={248} max={440} label={t("web.runtime.inspectorTitle")} />
            </If>
            <View
              testID="runtimes-inspector-head"
              desktop={{ windowDrag: true }}
              class="h-9 shrink-0 flex-row items-center justify-between gap-2 border-b border-line px-3"
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
            <Scroll class="min-h-0 flex-1" contentClass="gap-3 p-3 pb-6">
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
    <View testID="runtimes-sidebar" accessibilityLabel={t("web.base.place.runtimes.label")} class="h-full w-62 shrink-0 border-r border-line bg-side">
      <View testID="runtimes-sidebar-head" desktop={{ windowDrag: true }} class="h-9 shrink-0 flex-row items-center gap-1.5 border-b border-line px-2.5">
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

      <Scroll testID="runtimes" class="min-h-0 flex-1" contentClass="gap-3 p-2 pb-4">
        <If
          when={props.groups.length > 0}
          else={
            <If
              when={props.loading}
              else={
                <Text testID="runtimes-sidebar-empty" class="px-2 py-3 text-xs text-muted">
                  {t("web.runtime.noneInstalled")}
                </Text>
              }
            >
              <Text class="px-2 py-3 text-xs text-muted">{t("web.runtime.reading")}</Text>
            </If>
          }
        >
          <Each of={props.groups} key={(g) => g.machine.id}>
            {(group) => {
              const kind = () => machineKindMeta(machineKindOf(group().machine));
              const state = () => machineStatusMeta(group().machine.status);
              return (
                <View testID={`machine-group-${group().machine.id}`} class="gap-1">
                  <View class="flex-row items-center gap-1.5 px-2 pt-1 pb-0.5">
                    <Dot tone={state().dot} size={6} ring={false} />
                    <Text class="min-w-0 flex-1 truncate text-xs font-semibold text-muted">{group().machine.name}</Text>
                    <View class="rounded-xs bg-hover px-1 py-px">
                      <Text class="text-2xs text-faint">{kind().label}</Text>
                    </View>
                    <Text class="shrink-0 font-mono text-2xs text-faint tabular-nums">{String(group().runtimes.length)}</Text>
                  </View>
                  <View class="gap-0.5">
                    <Each of={group().runtimes} key={(e) => e.key}>
                      {(entry) => {
                        const active = () => props.selectedKey === entry().key;
                        const using = () => props.agentsByKey.get(entry().key)?.length ?? 0;
                        const quota = () => {
                          const info = entry().info;
                          if (!info || !entry().available) return undefined;
                          const q = quotaOf(info);
                          return q.level === "unknown" ? undefined : q;
                        };
                        return (
                          <A
                            href={runtimeHref(entry().machineId, entry().runtimeId)}
                            testID={`runtime-row-${entry().machineId}-${entry().runtimeId}`}
                            accessibilityLabel={`${entry().label} · ${group().machine.name}`}
                            accessibilityState={{ selected: active() }}
                            class={`relative flex-row items-center gap-2.5 rounded-md px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-focus ${
                              active() ? "bg-selected" : "hover:bg-hover"
                            }`}
                          >
                            <If when={active()}>
                              <ActiveBar tall />
                            </If>
                            <RuntimeIcon runtime={entry().runtimeId} size={28} />
                            <View class="min-w-0 flex-1 gap-0.5">
                              <Text class={`truncate text-sm ${active() ? "font-semibold text-ink" : "font-medium text-ink"}`}>{entry().label}</Text>
                              <Text class="truncate text-2xs text-muted">
                                {`${statusOf(entry())}${using() > 0 ? t("web.runtime.usedBy", { n: using() }) : ""}`}
                              </Text>
                            </View>
                            <View class="shrink-0 items-end gap-1">
                              <View class={`h-2 w-2 rounded-full ${statusDotClass(entry())}`} />
                              <If when={quota()}>{(q) => <Stamina quota={q()} width={44} height={6} />}</If>
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
  const terminalDirectory = () => {
    const i = inst();
    if (!i) return undefined;
    if (i.status === "available") return folderOf(i.command);
    return i.status === "unsupported" && i.signInCommand ? folderOf(i.signInCommand) : undefined;
  };
  const remoteModels = computed(() => entry().summary?.models ?? []);

  return (
    <View testID="runtime-detail" class="mx-auto w-full max-w-4xl gap-4">
      <View class="flex-row items-center gap-4 rounded-lg border border-line bg-side p-4">
        <RuntimeIcon runtime={entry().runtimeId} size={52} />
        <View class="min-w-0 flex-1 gap-1">
          <View class="flex-row flex-wrap items-center gap-2">
            <Text role="header" class="text-lg font-semibold text-ink">
              {entry().label}
            </Text>
            <Tag icon={machineKindMeta(machineKindOf(machine())).icon} tone={machineKindMeta(machineKindOf(machine())).tone} label={machine().name} />
          </View>
          <If when={info()?.preset.blurb} else={<Text class="text-xs text-muted">{t("web.runtime.remoteSummary", { machine: machine().name })}</Text>}>
            {(blurb) => <Text class="text-xs text-muted">{blurb()}</Text>}
          </If>
          <If when={inst()}>
            {(i) => (
              <View class="flex-row flex-wrap items-center gap-2 pt-0.5">
                <If when={variant(i(), "status", "available")}>
                  {(avail) => (
                    <>
                      <View class="rounded-sm bg-ok-soft px-1.5 py-0.5">
                        <Text class="text-2xs font-medium text-ok-ink tabular-nums">{`${t("web.runtime.available")} ${avail().version ?? ""}`}</Text>
                      </View>
                      <View class="min-w-0 max-w-full shrink" tooltip={<Bubble text={avail().command} />}>
                        <Text class="truncate font-mono text-xs text-muted">{avail().command}</Text>
                      </View>
                      <If when={folderOf(avail().command)}>{(cwd) => <OpenTerminal cwd={cwd()} title={entry().label} testid="runtime-terminal" />}</If>
                      <Text class="text-xs text-faint">{avail().via === "bundled" ? t("web.runtime.bundled") : t("web.runtime.commandLine")}</Text>
                    </>
                  )}
                </If>
                <If when={variant(i(), "status", "unsupported")}>
                  {(unsup) => (
                    <If
                      when={unsup().signInCommand}
                      else={
                        <View class="rounded-sm bg-bad-soft px-1.5 py-0.5">
                          <Text class="text-2xs font-medium text-berry">{t("web.runtime.unsupportedWhy", { why: unsup().reason })}</Text>
                        </View>
                      }
                    >
                      {(command) => (
                        <>
                          <View class="rounded-sm bg-warn-soft px-1.5 py-0.5">
                            <Text class="text-2xs font-medium text-warn-ink">{t("web.runtime.quota.signedOut")}</Text>
                          </View>
                          <View class="min-w-0 max-w-full shrink" tooltip={<Bubble text={command()} />}>
                            <Text class="truncate font-mono text-xs text-muted">{command()}</Text>
                          </View>
                        </>
                      )}
                    </If>
                  )}
                </If>
                <If when={info()?.checkedAt}>
                  {(at) => <Text class="text-2xs text-faint tabular-nums">{t("web.runtime.checkedAt", { clock: wallClockText(at()) })}</Text>}
                </If>
              </View>
            )}
          </If>
        </View>
      </View>

      <If when={info()}>
        {(localInfo) => (
          <>
            <Card title={t("web.runtime.account")}>
              <Usage info={localInfo()} terminalDirectory={terminalDirectory()} />
            </Card>
            <SettingsCard info={localInfo()} onSaved={(got) => props.onSaved(got)} pathRef={() => {}} />
            <ModelsCard info={localInfo()} />
          </>
        )}
      </If>

      <If when={!info()}>
        <Card
          title={t("web.runtime.models")}
          action={
            <If when={remoteModels().length > 0}>
              <Text class="text-xs text-muted tabular-nums">{t("web.runtime.modelCount", { n: remoteModels().length })}</Text>
            </If>
          }
        >
          <If when={remoteModels().length > 0} else={<Quiet>{t("web.runtime.noModels")}</Quiet>}>
            <View class="gap-1.5">
              <Each of={remoteModels()} key={(m) => m.id}>
                {(m) => (
                  <View class="flex-row items-center justify-between gap-2 rounded-md border border-line bg-page px-3 py-1.5">
                    <View class="min-w-0 flex-row items-center gap-2">
                      <Text class="truncate font-mono text-xs text-ink">{m().id}</Text>
                      <If when={m().isDefault}>
                        <View class="rounded-sm bg-ok-soft px-1.5 py-0.5">
                          <Text class="text-2xs font-medium text-ok-ink">{t("web.runtime.default")}</Text>
                        </View>
                      </If>
                    </View>
                    <Text class="shrink-0 text-xs text-muted">{m().effortLevels.join(" · ") || "—"}</Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </Card>
      </If>

      <Card
        title={t("web.runtime.agents")}
        action={
          <A
            href={`/agents/new?runtime=${encodeURIComponent(entry().runtimeId)}`}
            testID="new-agent"
            class="group flex-row items-center gap-1 rounded-sm px-1.5 py-0.5 hover:bg-hover"
          >
            <Text class="text-xs text-muted underline group-hover:text-ink">{t("web.runtime.makeAgent")}</Text>
            <Icon name="next" size={12} tone="muted" />
          </A>
        }
      >
        <If when={props.agents.length > 0} else={<Quiet>{t("web.runtime.noneYet")}</Quiet>}>
          <View class="flex-row flex-wrap gap-2">
            <Each of={props.agents} key={(a) => a.id}>
              {(a) => (
                <A
                  href={`/agents/${encodeURIComponent(a().id)}`}
                  class="flex-row items-center gap-1.5 rounded-md border border-line bg-page py-1 pr-3 pl-1 hover:bg-hover"
                >
                  <AgentFace agentId={a().id} name={a().name} runtime={a().runtime} look={a().look} size={24} />
                  <Text class="text-sm font-medium text-ink">{a().name}</Text>
                </A>
              )}
            </Each>
          </View>
        </If>
      </Card>

      <Card
        title={t("web.runtime.sessions")}
        action={
          <If when={props.sessions.length > 0}>
            <CountPill count={props.sessions.length} />
          </If>
        }
      >
        <If when={props.sessions.length > 0} else={<Quiet>{t("web.runtime.noSessions")}</Quiet>}>
          <View class="gap-1.5">
            <Each of={props.sessions.slice(0, 6)} key={(s) => s.id}>
              {(s) => (
                <A
                  href={`/runs`}
                  testID={`runtime-session-${s().id}`}
                  class="flex-row items-center gap-2 rounded-md border border-line bg-page px-3 py-2 hover:bg-hover"
                >
                  <Dot tone={s().phase._tag === "working" ? "leaf" : s().phase._tag === "failed" ? "berry" : "faint"} size={6} ring={false} />
                  <Text class="min-w-0 flex-1 truncate text-xs font-medium text-ink">{s().name || s().brief || s().id}</Text>
                  <Text class="shrink-0 text-2xs text-muted">{s().phaseText}</Text>
                </A>
              )}
            </Each>
          </View>
        </If>
      </Card>
    </View>
  );
}

function InspectorRow(props: { label: string; value: string; mono?: boolean }) {
  return (
    <View class="flex-row items-center justify-between gap-2">
      <Text class="shrink-0 text-xs text-muted">{props.label}</Text>
      <Text class={`min-w-0 truncate text-right text-xs text-ink ${props.mono === true ? "font-mono" : ""}`}>{props.value}</Text>
    </View>
  );
}

function RuntimeInspector(props: { selected: SelectedMachineRuntime; groupCount: number; recheckBusy: boolean; onRecheck: () => void }) {
  const machine = () => props.selected.machine;
  const entry = () => props.selected.entry;
  const kind = () => machineKindMeta(machineKindOf(machine()));
  const plat = () => platformMeta(machine().platform);
  const state = () => machineStatusMeta(machine().status);
  const remoteCaps = computed(() => new Set(entry().summary?.capabilities ?? []));

  return (
    <>
      <View testID={`inspector-machine-${machine().id}`} class="gap-2.5 rounded-lg border border-line bg-page p-3">
        <View class="flex-row items-center gap-2">
          <Icon name="devices" size={14} tone="muted" />
          <Text class="min-w-0 flex-1 truncate text-xs font-semibold text-ink">{t("web.runtime.machines.title")}</Text>
          <View class="flex-row items-center gap-1.5">
            <Dot tone={state().dot} size={6} ring={false} />
            <Text testID={`machine-status-${machine().id}`} class="text-2xs font-medium text-muted">
              {state().label}
            </Text>
          </View>
        </View>
        <Text class="truncate text-sm font-semibold text-ink">{machine().name}</Text>
        <View class="flex-row flex-wrap items-center gap-1.5">
          <Tag icon={kind().icon} tone={kind().tone} label={kind().label} />
          <Tag icon={plat().icon} tone="neutral" label={plat().label} />
        </View>
        <View class="gap-1.5 border-t border-line pt-2">
          <InspectorRow label={t("web.runtime.machines.machineId")} value={machine().id} mono />
          <InspectorRow label={t("web.runtime.machines.installedCount")} value={String(props.groupCount)} mono />
          <If when={machine().worktreeSupported !== undefined}>
            <InspectorRow
              label={t("web.runtime.machines.worktree")}
              value={machine().worktreeSupported === true ? t("web.runtime.machines.worktreeYes") : t("web.runtime.machines.worktreeNo")}
            />
          </If>
          <If when={machine().lastSeenAt ?? machine().joinedAt}>
            {(ts) => <InspectorRow label={t("web.runtime.machines.lastSeen")} value={momentText(ts())} />}
          </If>
        </View>
      </View>

      <If
        when={entry().info}
        else={
          <Card title={t("web.runtime.can")}>
            <View class="flex-row flex-wrap gap-1.5">
              <Each of={RuntimeCapabilityValues} key={(c) => c}>
                {(c) => (
                  <View class={`rounded-sm px-1.5 py-0.5 ${remoteCaps().has(c()) ? "bg-selected" : "bg-hover"}`}>
                    <Text class={`text-xs ${remoteCaps().has(c()) ? "font-medium text-ink" : "text-faint line-through"}`}>{capabilityLabel[c()]}</Text>
                  </View>
                )}
              </Each>
            </View>
          </Card>
        }
      >
        {(info) => (
          <>
            <SupportCard info={info()} />
            <InventoryCard title={t("web.runtime.mcp")} entries={info().mcpServers} />
            <InventoryCard title={t("web.runtime.skills")} entries={info().skills} />
            <InventoryCard title={t("web.runtime.tools")} entries={info().tools} />
          </>
        )}
      </If>

      <Card title={t("web.runtime.quickActions")}>
        <View class="flex-row flex-wrap gap-2">
          <Button size="compact" icon="refresh" disabled={props.recheckBusy} onPress={() => props.onRecheck()}>
            {props.recheckBusy ? t("web.runtime.checking") : t("web.runtime.recheck")}
          </Button>
        </View>
      </Card>
    </>
  );
}
