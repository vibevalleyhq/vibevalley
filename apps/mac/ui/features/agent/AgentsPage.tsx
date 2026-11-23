import { Scroll, signal, Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import { type Agent, defaultOrchestrator, type RuntimeInfo, TemplateCategoryValues } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button, ButtonLink } from "../../design/Button";
import { AgentFace, OrchestratorFace } from "../../design/domain/Face";
import { SearchField } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { Empty, PageBody, Toggle } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { CountPill, Dot } from "../../design/Tag";
import { Bubble, Hint } from "../../design/Tip";
import { useAgentProblems, useOrchestrators, useWorkAgents } from "../../infra/agents";
import { api } from "../../infra/api";
import { ready, useAgentTemplates, useQueryClient, useRuntimes } from "../../infra/query";
import { Link as A } from "../../infra/router";
import { createMemo } from "../../infra/solid";
import { AgentPage } from "./AgentPage";
import { orchestratorHref } from "./OrchestratorProfile";
import { type CategoryFilter, categoryLabel, matchesTemplateQuery, TemplateCard, templateCategoryOf } from "./TemplateCard";
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
  const templates = useAgentTemplates();
  const runtimes = useRuntimes();
  const problems = useAgentProblems(agents);

  const roleFilter = signal<RoleFilter>("all");
  const category = signal<CategoryFilter>("all");
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
  const roleMatchedTemplates = createMemo(() =>
    ready(templates, []).filter(
      (tpl) => (tpl.role === "orchestrator" ? showsOrchestrators(roleFilter()) : showsWorkers(roleFilter())) && matchesTemplateQuery(tpl, needle()),
    ),
  );
  const visibleTemplates = createMemo(() =>
    category() === "all" ? roleMatchedTemplates() : roleMatchedTemplates().filter((tpl) => templateCategoryOf(tpl) === category()),
  );

  const hasFilter = () => roleFilter() !== "all" || needle().length > 0;
  const noMatches = () => hasFilter() && visibleOrchestrators().length === 0 && visibleWorkers().length === 0 && visibleTemplates().length === 0;
  const hasProfileSection = () =>
    (showsOrchestrators(roleFilter()) && visibleOrchestrators().length > 0) || (showsWorkers(roleFilter()) && visibleWorkers().length > 0);

  const clearFilters = () => {
    roleFilter.set("all");
    category.set("all");
    query.set("");
  };

  return (
    <Scroll testID="agents-page" onLayout={(e) => width.set(e.bounds.size.width)} class="h-full flex-1 bg-page" contentClass="px-3.5 pt-3 pb-8">
      <PageBody width="manage">
        <View testID="agents-toolbar" class="flex-row flex-wrap items-center justify-between gap-3">
          <View class="flex-row flex-wrap items-center gap-2">
            <Segmented
              testid="agents-role-filter"
              label={t("web.agent.list.filterLabel")}
              value={roleFilter()}
              onChange={(v) => roleFilter.set(v)}
              options={[
                { value: "all", label: t("web.agent.list.all"), count: orchestrators().length + agents().length },
                { value: "orchestrator", label: t("web.agent.list.orchestrators"), count: orchestrators().length },
                { value: "worker", label: t("web.agent.list.helpers"), count: agents().length },
              ]}
            />
            <SearchField
              testid="agents-search"
              clearTestid="agents-search-clear"
              clearLabel={t("web.agent.list.clearFilter")}
              value={query()}
              onInput={(v) => query.set(v)}
              placeholder={t("web.agent.list.searchHint")}
              label={t("web.agent.list.search")}
              class="w-56"
            />
          </View>
          <View class="flex-row flex-wrap items-center gap-1.5">
            <ButtonLink
              href="/agents/templates"
              tone="quiet"
              testID="open-templates"
              icon="folder"
              tooltip={<Bubble text={t("web.agent.templates.openLine")} />}
            >
              {t("web.agent.templates.open")}
            </ButtonLink>
            <ButtonLink href="/agents/new?role=orchestrator" tone="quiet" testID="new-orchestrator" icon="add">
              {t("web.agent.list.makeOrchestrator")}
            </ButtonLink>
            <ButtonLink href="/agents/new" tone="primary" testID="new-agent" icon="add">
              {t("web.agent.list.make")}
            </ButtonLink>
          </View>
        </View>

        <If
          when={!noMatches()}
          else={
            <Empty
              compact
              testid="agents-empty-search"
              icon="search"
              action={
                <Button testID="agents-clear-filter" size="compact" onPress={clearFilters}>
                  {t("web.agent.list.clearFilter")}
                </Button>
              }
            >
              {t("web.agent.list.emptySearch")}
            </Empty>
          }
        >
          <If when={showsOrchestrators(roleFilter()) && visibleOrchestrators().length > 0}>
            <GroupSection title={t("web.agent.list.orchestrators")} count={visibleOrchestrators().length} testid="agents-group-orchestrators">
              <View class="overflow-hidden rounded-lg border border-line bg-page">
                <Each of={visibleOrchestrators()} key={(a) => a.id}>
                  {(a, i) => <OrchestratorRow agent={a()} first={i() === 0} wide={wide()} />}
                </Each>
              </View>
            </GroupSection>
          </If>

          <If when={showsWorkers(roleFilter()) && visibleWorkers().length > 0}>
            <GroupSection title={t("web.agent.list.helpers")} count={visibleWorkers().length} testid="agents-group-workers">
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
            </GroupSection>
          </If>

          <If when={ready(templates, []).length > 0}>
            <View testID="agents-templates-gallery" class={hasProfileSection() ? "gap-3 border-t border-line pt-5" : "gap-3"}>
              <View class="flex-row flex-wrap items-center justify-between gap-2">
                <View class="flex-row items-center gap-2">
                  <Text role="header" class="text-xs font-semibold text-muted">
                    {t("web.agent.templates.galleryTitle")}
                  </Text>
                  <CountPill count={visibleTemplates().length} />
                  <Hint text={t("web.agent.templates.galleryIntro")} />
                </View>
                <ButtonLink href="/agents/templates" tone="quiet" size="compact" testID="gallery-manage-templates">
                  <>
                    <Text class="text-xs text-ink">{t("web.agent.templates.manageLink")}</Text>
                    <Icon name="next" size={12} tone="muted" />
                  </>
                </ButtonLink>
              </View>
              <Segmented
                testid="templates-category-filter"
                label={t("web.agent.templates.galleryTitle")}
                value={category()}
                onChange={(v) => category.set(v)}
                options={[
                  { value: "all", label: categoryLabel("all"), count: roleMatchedTemplates().length },
                  ...TemplateCategoryValues.map((cat) => ({
                    value: cat,
                    label: categoryLabel(cat),
                    count: roleMatchedTemplates().filter((tpl) => templateCategoryOf(tpl) === cat).length,
                  })),
                ]}
              />
              <View class="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                <Each of={visibleTemplates()} key={(tpl) => tpl.id}>
                  {(tpl) => <TemplateCard template={tpl()} runtimes={ready(runtimes, [])} />}
                </Each>
              </View>
            </View>
          </If>
        </If>
      </PageBody>
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
          <CountPill count={props.count} />
        </If>
      </View>
      {props.children}
    </View>
  );
}

function RowShell(props: { agent: Agent; to: string; first: boolean; muted?: boolean; trailing?: JSX.Element; children: JSX.Element }) {
  return (
    <View
      class={`flex-row items-center gap-3 px-3.5 py-2.5 hover:bg-hover ${
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
    <RowShell agent={props.agent} to={orchestratorHref(props.agent.id)} first={props.first} trailing={<View class="w-7" />}>
      <View class="h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-side">
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
        <Text class="truncate text-xs text-muted">{props.agent.duty || t("web.agent.list.orchestratorLine")}</Text>
      </View>
      <If when={props.wide}>
        <View class="shrink-0 flex-row items-center gap-3">
          <View class="w-52 flex-row items-center">
            <Text class="min-w-0 flex-1 truncate text-xs text-muted">{summary()}</Text>
          </View>
          <View class="w-28" />
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
          <Toggle
            bare
            checked={props.agent.enabled}
            disabled={act.busy()}
            ariaLabel={toggleLabel()}
            testid={`toggle-${props.agent.enabled ? "on" : "off"}`}
            onChange={() => void toggle()}
          />
        </View>
      }
    >
      <View class="h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-side">
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
        <Text class="truncate text-xs text-muted">{props.agent.duty || runtimeSpec()}</Text>
      </View>
      <If when={props.wide}>
        <View class="shrink-0 flex-row items-center gap-3">
          <View class="w-52 flex-row items-center gap-1.5">
            <Dot tone={available() ? "leaf" : "berry"} size={7} ring={false} />
            <Text class="min-w-0 flex-1 truncate text-xs text-muted">{runtimeSpec()}</Text>
          </View>
          <View class="w-28 flex-row items-center justify-end gap-1 overflow-hidden">
            <Each of={shownTags()}>
              {(tag) => (
                <View class="max-w-full shrink rounded-sm bg-hover px-1.5 py-px">
                  <Text class="truncate text-2xs text-muted">{tag()}</Text>
                </View>
              )}
            </Each>
          </View>
        </View>
      </If>
    </RowShell>
  );
}
