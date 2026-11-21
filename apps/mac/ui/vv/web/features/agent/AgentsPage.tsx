// Converged Linear-style grouped list of orchestrators and helpers, with a
// unified filter/search/action toolbar and an always-visible worker toggle.
import { Scroll, signal, Text, View, type JSX } from "nsh";
import { Switch } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { type Agent, defaultOrchestrator, type RuntimeInfo } from "@vibevalley/protocol";

import { createMemo } from "../../../solid";
import { useAgentProblems, useOrchestrators, useWorkAgents } from "../../infra/agents";
import { api } from "../../infra/api";
import { ready, useQueryClient, useRuntimes } from "../../infra/query";
import { Link as A } from "../../infra/router";
import { createAct } from "../../ui/act";
import { Button } from "../../ui/Button";
import { hexColor } from "../../ui/domain/cast";
import { AgentFace, OrchestratorFace } from "../../ui/domain/Face";
import { TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Segmented } from "../../ui/Segmented";
import { Bubble } from "../../ui/Tip";
import { AgentPage } from "./AgentPage";
import { orchestratorHref } from "./OrchestratorProfile";
import { TemplatesPage } from "./TemplatesPage";

type RoleFilter = "all" | "orchestrator" | "worker";

function showsOrchestrators(filter: RoleFilter): boolean {
  switch (filter) {
    case "all":
    case "orchestrator":
      return true;
    case "worker":
      return false;
  }
}

function showsWorkers(filter: RoleFilter): boolean {
  switch (filter) {
    case "all":
    case "worker":
      return true;
    case "orchestrator":
      return false;
  }
}

function matchesProfileQuery(agent: Agent, runtime: RuntimeInfo | undefined, needle: string): boolean {
  if (!needle) return true;
  const hay = [agent.name, agent.duty, agent.runtime, runtime?.preset.label ?? "", agent.model, agent.effort, ...agent.tags].join(" ").toLowerCase();
  return hay.includes(needle);
}

/** `rest` is the path after /agents/. */
export function AgentsRoute(props: { rest: string }) {
  return (
    <If when={props.rest} else={<AgentsPage />}>
      {(id) => <Each of={[id()]}>{(at) => (at() === "templates" ? <TemplatesPage /> : <AgentPage id={decodeURIComponent(at())} />)}</Each>}
    </If>
  );
}

function AgentsPage() {
  const agents = useWorkAgents();
  const orchestrators = useOrchestrators();
  const runtimes = useRuntimes();
  const problems = useAgentProblems(agents);

  const roleFilter = signal<RoleFilter>("all");
  const query = signal("");
  const width = signal(0);
  const wide = () => width() === 0 || width() >= 680;

  const runtimeById = createMemo(() => new Map(ready(runtimes, []).map((r) => [r.id, r])));
  const needle = () => query().trim().toLowerCase();

  const visibleOrchestrators = createMemo(() =>
    showsOrchestrators(roleFilter()) ? orchestrators().filter((a) => matchesProfileQuery(a, runtimeById().get(a.runtime), needle())) : [],
  );
  const visibleWorkers = createMemo(() =>
    showsWorkers(roleFilter()) ? agents().filter((a) => matchesProfileQuery(a, runtimeById().get(a.runtime), needle())) : [],
  );

  const hasFilter = () => roleFilter() !== "all" || needle().length > 0;
  const noMatches = () => hasFilter() && visibleOrchestrators().length === 0 && visibleWorkers().length === 0;

  const clearFilters = () => {
    roleFilter.set("all");
    query.set("");
  };

  return (
    <Scroll testID="agents-page" onLayout={(e) => width.set(e.bounds.size.width)} class="h-full flex-1 bg-page" contentClass="gap-5 px-5 pt-4 pb-8">
      <View testID="agents-toolbar" class="flex-row flex-wrap items-center justify-between gap-3">
        <View class="flex-row flex-wrap items-center gap-2">
          <Segmented
            testid="agents-role-filter"
            label={t("web.agent.list.filterLabel")}
            value={roleFilter()}
            onChange={roleFilter.set}
            options={[
              { value: "all", label: t("web.agent.list.all") },
              { value: "orchestrator", label: t("web.agent.list.orchestrators") },
              { value: "worker", label: t("web.agent.list.helpers") },
            ]}
          />
          <View class="flex-row items-center gap-1">
            <TextInput
              testID="agents-search"
              accessibilityLabel={t("web.agent.list.search")}
              placeholder={t("web.agent.list.searchHint")}
              wide={false}
              class="h-7 w-56"
              value={query()}
              onInput={query.set}
            />
            <If when={query().length > 0}>
              <View
                role="button"
                testID="agents-search-clear"
                accessibilityLabel={t("web.agent.list.clearFilter")}
                onPress={() => query.set("")}
                class="h-7 w-7 shrink-0 items-center justify-center rounded-md transition duration-120 ease-out hover:bg-hover active:translate-y-px"
              >
                <Icon name="close" size={12} tone="muted" />
              </View>
            </If>
          </View>
        </View>
        <View class="flex-row flex-wrap items-center gap-2">
          <A
            href="/agents/templates"
            testID="open-templates"
            tooltip={<Bubble text={t("web.agent.templates.openLine")} />}
            class="h-7 flex-row items-center gap-1.5 rounded-md border border-line bg-page px-2.5 transition duration-120 ease-out hover:border-faint hover:bg-hover active:translate-y-px"
          >
            <Icon name="folder" size={14} tone="muted" />
            <Text class="text-sm text-ink">{t("web.agent.templates.open")}</Text>
          </A>
          <A
            href="/agents/new?role=orchestrator"
            testID="new-orchestrator"
            class="h-7 flex-row items-center gap-1.5 rounded-md border border-line bg-page px-2.5 transition duration-120 ease-out hover:border-faint hover:bg-hover active:translate-y-px"
          >
            <Icon name="add" size={14} tone="muted" />
            <Text class="text-sm text-ink">{t("web.agent.list.makeOrchestrator")}</Text>
          </A>
          <A
            href="/agents/new"
            testID="new-agent"
            class="h-7 flex-row items-center gap-1.5 rounded-md border border-accent bg-accent px-2.5 transition duration-120 ease-out hover:border-accent-hover hover:bg-accent-hover active:translate-y-px"
          >
            <Icon name="add" size={14} tone="page" />
            <Text class="text-sm font-medium text-page">{t("web.agent.list.make")}</Text>
          </A>
        </View>
      </View>

      <If
        when={!noMatches()}
        else={
          <View testID="agents-empty-search" class="items-center justify-center gap-3 rounded-lg border border-line bg-side px-6 py-10">
            <Text class="text-sm text-muted">{t("web.agent.list.emptySearch")}</Text>
            <Button testID="agents-clear-filter" size="compact" onPress={clearFilters}>
              {t("web.agent.list.clearFilter")}
            </Button>
          </View>
        }
      >
        <If when={showsOrchestrators(roleFilter()) && (visibleOrchestrators().length > 0 || !hasFilter())}>
          <GroupSection title={t("web.agent.list.orchestrators")} count={visibleOrchestrators().length} testid="agents-group-orchestrators">
            <If when={visibleOrchestrators().length > 0}>
              <View class="overflow-hidden rounded-lg border border-line bg-page">
                <Each of={visibleOrchestrators()} key={(a) => a.id}>
                  {(a, i) => <OrchestratorRow agent={a()} first={i() === 0} wide={wide()} />}
                </Each>
              </View>
            </If>
          </GroupSection>
        </If>

        <If when={showsWorkers(roleFilter()) && (visibleWorkers().length > 0 || !hasFilter())}>
          <GroupSection title={t("web.agent.list.helpers")} count={visibleWorkers().length} testid="agents-group-workers">
            {/* The default orchestrator is always there: once it shows, the profiles are read. */}
            <If
              when={visibleWorkers().length > 0}
              else={
                <If when={orchestrators().length > 0 && agents().length === 0}>
                  <A href="/agents/templates" class="self-start">
                    <Text class="text-sm text-muted hover:underline">{t("web.agent.templates.none")}</Text>
                  </A>
                </If>
              }
            >
              <View class="overflow-hidden rounded-lg border border-line bg-page">
                <Each of={visibleWorkers()} key={(a) => a.id}>
                  {(a, i) => (
                    <WorkerRow
                      agent={a()}
                      runtime={runtimeById().get(a().runtime)}
                      errors={(problems()[a().id] ?? []).filter((item) => item.level === "error").map((item) => item.text)}
                      first={i() === 0}
                      wide={wide()}
                    />
                  )}
                </Each>
              </View>
            </If>
          </GroupSection>
        </If>
      </If>
    </Scroll>
  );
}

function GroupSection(props: { title: string; count: number; testid: string; children: JSX.Element }) {
  return (
    <View testID={props.testid} class="gap-2">
      <View class="flex-row items-center gap-2">
        <Text role="header" class="text-xs font-semibold text-muted">
          {props.title}
        </Text>
        <If when={props.count > 0}>
          <View class="rounded-sm bg-hover px-1.5 py-px">
            <Text class="text-2xs font-medium text-muted tabular-nums">{String(props.count)}</Text>
          </View>
        </If>
      </View>
      {props.children}
    </View>
  );
}

function RowShell(props: { agent: Agent; to: string; first: boolean; muted?: boolean; trailing?: JSX.Element; children: JSX.Element }) {
  return (
    <View
      class={`flex-row items-center gap-3 px-3.5 py-2.5 transition-colors duration-120 ease-out hover:bg-hover ${
        props.first ? "" : "border-t border-line"
      } ${props.muted === true ? "opacity-75" : ""}`}
    >
      <A href={props.to} testID={`agent-card-${props.agent.id}`} accessibilityLabel={props.agent.name} class="min-w-0 flex-1 flex-row items-center gap-3">
        {props.children}
      </A>
      <View class="shrink-0 flex-row items-center gap-2.5">
        {props.trailing}
        <A href={props.to} accessibilityLabel={props.agent.name} class="flex h-6 w-5 items-center justify-center rounded-sm">
          <Icon name="next" size={14} tone="faint" />
        </A>
      </View>
    </View>
  );
}

function OrchestratorRow(props: { agent: Agent; first: boolean; wide: boolean }) {
  const isDefault = () => props.agent.id === defaultOrchestrator;
  const summary = () => props.agent.model || t("web.agent.list.orchestratorSummary");
  return (
    <RowShell agent={props.agent} to={orchestratorHref(props.agent.id)} first={props.first}>
      <View class="h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-hover">
        <OrchestratorFace size={34} agent={props.agent.id} />
      </View>
      <View class="min-w-0 flex-1 gap-0.5">
        <View class="flex-row items-center gap-2">
          <Text class="min-w-0 shrink truncate text-sm font-semibold text-ink">{props.agent.name}</Text>
          <If when={isDefault()}>
            <View class="shrink-0 rounded-sm border border-line bg-side px-1.5 py-px">
              <Text class="text-2xs font-medium text-muted">{t("web.agent.list.defaultBadge")}</Text>
            </View>
          </If>
        </View>
        <Text class="truncate text-xs text-muted" style={{ numberOfLines: 1 }}>
          {props.agent.duty || t("web.agent.list.orchestratorLine")}
        </Text>
      </View>
      <If when={props.wide}>
        <View class="shrink-0 flex-row items-center gap-2">
          <Text class="text-xs text-muted">{summary()}</Text>
        </View>
      </If>
    </RowShell>
  );
}

function WorkerRow(props: { agent: Agent; runtime?: RuntimeInfo | undefined; errors: string[]; first: boolean; wide: boolean }) {
  const client = useQueryClient();
  const available = () => props.runtime?.installation.status === "available";
  const act = createAct();
  // The API saves a whole profile, and the cached one may be older than an edit made since (in another window).
  const toggle = () => {
    const { id, enabled } = props.agent;
    return act.run(async () => {
      const latest = (await api.agent.list()).find((a) => a.id === id);
      if (latest) await api.agent.update({ ...latest, enabled: !enabled });
      await client.invalidate({ prefix: ["agents"] });
    });
  };
  const runtimeSpec = () => [props.runtime?.preset.label ?? props.agent.runtime, props.agent.model, props.agent.effort].filter(Boolean).join(" · ");
  const toggleAction = () => (props.agent.enabled ? t("web.agent.list.disable") : t("web.agent.list.enable"));
  const toggleLabel = () => t("web.agent.list.toggle", { act: toggleAction(), name: props.agent.name });
  const healthy = () => props.errors.length === 0;
  const shownTags = () => (healthy() ? props.agent.tags.slice(0, 2) : []);
  return (
    <RowShell
      agent={props.agent}
      to={`/agents/${encodeURIComponent(props.agent.id)}`}
      first={props.first}
      muted={!props.agent.enabled}
      trailing={
        <View tooltip={<Bubble text={toggleLabel()} />}>
          <Switch
            testID={`toggle-${props.agent.enabled ? "on" : "off"}`}
            checked={props.agent.enabled}
            disabled={act.busy()}
            hitSlop={4}
            accessibilityLabel={toggleLabel()}
            onChange={() => void toggle()}
            class="shrink-0"
            trackClass="h-4 w-7 justify-center rounded-full border border-line bg-selected p-0.5 transition-colors duration-180 ease-out checked:border-accent checked:bg-accent focus-visible:outline-2 focus-visible:outline-focus"
            thumbClass="size-2.5 rounded-full bg-page shadow-raise transition-transform duration-180 ease-out checked:translate-x-3"
          />
        </View>
      }
    >
      <View
        class="h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md bg-hover"
        style={{ backgroundColor: `${hexColor(props.agent.look.hat)}29` }}
      >
        <AgentFace
          agentId={props.agent.id}
          name={props.agent.name}
          runtime={props.agent.runtime}
          look={props.agent.look}
          size={34}
          muted={!props.agent.enabled}
        />
      </View>
      <View class="min-w-0 flex-1 gap-0.5">
        <View class="flex-row items-center gap-1.5">
          <Text class="min-w-0 shrink truncate text-sm font-semibold text-ink">{props.agent.name}</Text>
          <If when={!props.agent.enabled}>
            <View class="shrink-0 rounded-sm bg-hover px-1.5 py-px">
              <Text class="text-2xs font-medium text-muted">{t("web.agent.list.disabledBadge")}</Text>
            </View>
          </If>
          <If when={props.errors.length > 0}>
            <View tooltip={<Bubble text={props.errors.join("\n")} />} class="max-w-60 shrink rounded-sm bg-bad-soft px-1.5 py-px">
              <Text testID="agent-card-error" class="truncate text-2xs font-medium text-berry">
                {t("web.agent.cannot") + (props.errors[0] ?? "")}
              </Text>
            </View>
          </If>
        </View>
        <Text class="truncate text-xs text-muted" style={{ numberOfLines: 1 }}>
          {props.agent.duty || runtimeSpec()}
        </Text>
      </View>
      <If when={props.wide}>
        <View class="shrink-0 flex-row items-center gap-3">
          <View class="flex-row items-center gap-1.5">
            <View class={`h-1.75 w-1.75 shrink-0 rounded-full ${available() ? "bg-leaf" : "bg-berry"}`} />
            <Text class="text-xs text-muted">{runtimeSpec()}</Text>
          </View>
          <If when={shownTags().length > 0}>
            <View class="flex-row items-center gap-1">
              <Each of={shownTags()}>
                {(tag) => (
                  <View class="rounded-sm bg-hover px-1.5 py-px">
                    <Text class="text-2xs text-muted">{tag()}</Text>
                  </View>
                )}
              </Each>
            </View>
          </If>
        </View>
      </If>
    </RowShell>
  );
}
