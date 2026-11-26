import { Scroll, signal, Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import { type Agent, defaultOrchestrator, type RuntimeInfo, TemplateCategoryValues } from "@vibevalley/protocol";

import { createAct } from "../../design/act";
import { Button, ButtonLink } from "../../design/Button";
import { AgentFace, OrchestratorFace } from "../../design/domain/Face";
import { SearchField } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { Empty, Toggle } from "../../design/layout";
import { Segmented } from "../../design/Segmented";
import { CountPill, Dot } from "../../design/Tag";
import { TextLink } from "../../design/TextLink";
import { Bubble } from "../../design/Tip";
import { useAgentProblems, useOrchestrators, useWorkAgents } from "../../infra/agents";
import { api } from "../../infra/api";
import { ready, useAgentTemplates, useQueryClient, useRuntimes } from "../../infra/query";
import { Link as A } from "../../infra/router";
import { createMemo } from "../../infra/solid";
import { assignWorkerAvatars, withDefaultWorkerAvatar } from "./AgentLook";
import { AgentPage } from "./AgentPage";
import { orchestratorHref } from "./OrchestratorProfile";
import { localizeAgentProblem, type LocalizedAgentProblem } from "./readiness";
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
      {(id) => (
        <Each of={[id()]} key={(v) => v}>
          {(at) => (
            <If when={at() === "templates"} else={<AgentPage id={decodeURIComponent(at())} />}>
              <TemplatesPage />
            </If>
          )}
        </Each>
      )}
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
  const wide = createMemo(() => width() === 0 || width() >= 720);

  const runtimeById = createMemo(() => new Map(ready(runtimes, []).map((r) => [r.id, r])));
  const needle = createMemo(() => query().trim().toLowerCase());
  const totalCount = createMemo(() => orchestrators().length + agents().length);

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

  const hasFilter = createMemo(() => roleFilter() !== "all" || needle().length > 0);
  const noMatches = createMemo(() => hasFilter() && visibleOrchestrators().length === 0 && visibleWorkers().length === 0 && visibleTemplates().length === 0);
  const hasProfileSection = createMemo(
    () => (showsOrchestrators(roleFilter()) && visibleOrchestrators().length > 0) || (showsWorkers(roleFilter()) && visibleWorkers().length > 0),
  );
  const roleOptions = createMemo(() => [
    { value: "all" as const, label: t("web.agent.list.all"), count: totalCount() },
    { value: "orchestrator" as const, label: t("web.agent.list.orchestrators"), count: orchestrators().length },
    { value: "worker" as const, label: t("web.agent.list.helpers"), count: agents().length },
  ]);
  const workerErrorsById = createMemo(() => {
    const map = new Map<string, LocalizedAgentProblem[]>();
    const all = problems();
    for (const [id, list] of Object.entries(all)) {
      const errs = list.filter((item) => item.level === "error").map((item) => localizeAgentProblem(item.text));
      if (errs.length > 0) map.set(id, errs);
    }
    return map;
  });
  const defaultWorkerAvatars = createMemo(() => assignWorkerAvatars(agents()));

  const clearFilters = () => {
    roleFilter.set("all");
    category.set("all");
    query.set("");
  };

  return (
    <View testID="agents-page" onLayout={(e) => width.set(e.bounds.size.width)} class="h-full min-h-0 flex-1 bg-page">
      <View
        testID="agents-toolbar"
        desktop={{ windowDrag: true }}
        class="h-11 shrink-0 flex-row items-center justify-between gap-3 border-b border-line bg-page px-4"
      >
        <View class="min-w-0 flex-row flex-wrap items-center gap-2.5">
          <View class="flex-row items-center gap-2">
            <Text role="header" class="shrink-0 text-sm font-semibold text-ink">
              {t("web.base.place.team.label")}
            </Text>
            <CountPill count={totalCount()} />
          </View>
          <View class="h-4 w-px shrink-0 bg-line" />
          <Segmented
            testid="agents-role-filter"
            label={t("web.agent.list.filterLabel")}
            value={roleFilter()}
            onChange={(v) => roleFilter.set(v)}
            options={roleOptions()}
          />
        </View>
        <View class="shrink-0 flex-row flex-wrap items-center gap-2">
          <SearchField
            testid="agents-search"
            clearTestid="agents-search-clear"
            clearLabel={t("web.agent.list.clearFilter")}
            value={query()}
            onInput={(v) => query.set(v)}
            placeholder={t("web.agent.list.searchHint")}
            label={t("web.agent.list.search")}
            class="w-52"
          />
          <ButtonLink href="/agents/templates" tone="quiet" testID="open-templates" icon="folder" tooltip={<Bubble text={t("web.agent.templates.openLine")} />}>
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

      <Scroll class="min-h-0 flex-1" contentClass="px-6 py-6 pb-10">
        <View class="mx-auto w-full max-w-230 gap-6">
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
                <View class="overflow-hidden rounded-xl border border-line bg-elevated">
                  <Each of={visibleOrchestrators()} key={(a) => a.id}>
                    {(a, i) => <OrchestratorRow agent={a()} first={i() === 0} wide={wide()} />}
                  </Each>
                </View>
              </GroupSection>
            </If>

            <If when={showsWorkers(roleFilter()) && visibleWorkers().length > 0}>
              <GroupSection title={t("web.agent.list.helpers")} count={visibleWorkers().length} testid="agents-group-workers">
                <View class="overflow-hidden rounded-xl border border-line bg-elevated">
                  <Each of={visibleWorkers()} key={(a) => a.id}>
                    {(a, i) => (
                      <WorkerRow
                        agent={a()}
                        defaultAvatar={defaultWorkerAvatars().get(a().id)}
                        runtime={runtimeById().get(a().runtime)}
                        errors={workerErrorsById().get(a().id) ?? []}
                        first={i() === 0}
                        wide={wide()}
                      />
                    )}
                  </Each>
                </View>
              </GroupSection>
            </If>

            <If when={ready(templates, []).length > 0}>
              <View testID="agents-templates-gallery" class={hasProfileSection() ? "mt-2 gap-4 border-t border-line pt-7" : "gap-4"}>
                <View class="flex-row flex-wrap items-start justify-between gap-3 px-0.5">
                  <View class="min-w-0 flex-1 gap-1">
                    <View class="flex-row items-center gap-2">
                      <Text role="header" class="text-sm font-semibold text-ink">
                        {t("web.agent.templates.galleryTitle")}
                      </Text>
                      <CountPill count={visibleTemplates().length} />
                    </View>
                    <Text class="text-xs leading-relaxed text-muted">{t("web.agent.templates.galleryIntro")}</Text>
                  </View>
                  <ButtonLink href="/agents/templates" tone="quiet" size="compact" testID="gallery-manage-templates">
                    <>
                      <Text class="text-xs font-medium text-muted">{t("web.agent.templates.manageLink")}</Text>
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
                <View class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                  <Each of={visibleTemplates()} key={(tpl) => tpl.id}>
                    {(tpl) => <TemplateCard template={tpl()} runtimes={ready(runtimes, [])} />}
                  </Each>
                </View>
              </View>
            </If>
          </If>
        </View>
      </Scroll>
    </View>
  );
}

function GroupSection(props: { title: string; count: number; testid: string; children: JSX.Element }) {
  return (
    <View testID={props.testid} class="gap-2">
      <View class="flex-row items-center justify-between gap-2 px-0.5">
        <View class="flex-row items-center gap-2">
          <Text role="header" class="text-xs font-semibold text-muted">
            {props.title}
          </Text>
          <If when={props.count > 0}>
            <CountPill count={props.count} />
          </If>
        </View>
      </View>
      {props.children}
    </View>
  );
}

function RowShell(props: {
  agent: Agent;
  to: string;
  first: boolean;
  wide: boolean;
  muted?: boolean;
  readiness?: JSX.Element;
  runtimePill: JSX.Element;
  action?: JSX.Element;
  children: JSX.Element;
}) {
  return (
    <View
      class={`min-h-14 flex-row items-center gap-4 px-4 py-3 hover:bg-hover ${props.first ? "" : "border-t border-line"} ${
        props.muted === true ? "opacity-65" : ""
      }`}
    >
      <A href={props.to} testID={`agent-card-${props.agent.id}`} accessibilityLabel={props.agent.name} class="min-w-0 flex-1 flex-row items-center gap-3">
        {props.children}
      </A>
      <If when={props.readiness}>
        <View class="shrink-0 flex-row items-center gap-2">{props.readiness}</View>
      </If>
      <If when={props.wide}>
        <View class="w-36 shrink-0 flex-row items-center">{props.runtimePill}</View>
      </If>
      <View class="w-16 shrink-0 flex-row items-center justify-end gap-2">
        {props.action}
        <A
          href={props.to}
          accessibilityLabel={props.agent.name}
          class="flex size-6 shrink-0 items-center justify-center rounded-sm hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
        >
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
    <RowShell
      agent={props.agent}
      to={orchestratorHref(props.agent.id)}
      first={props.first}
      wide={props.wide}
      runtimePill={
        <View tooltip={<Bubble text={summary()} />} class="h-6 max-w-full flex-row items-center gap-1.5 rounded-md border border-line bg-side px-2">
          <Dot tone="leaf" size={6} ring={false} />
          <Text class="min-w-0 truncate text-xs font-medium text-muted">{summary()}</Text>
        </View>
      }
    >
      <View class="size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-side">
        <OrchestratorFace size={30} agent={props.agent.id} />
      </View>
      <View class="min-w-0 flex-1 gap-0.5">
        <View class="flex-row items-center gap-1.5">
          <Text class="min-w-0 shrink truncate text-sm font-medium text-ink">{props.agent.name}</Text>
          <If when={isDefault()}>
            <View class="shrink-0 rounded-full bg-hover px-2 py-px">
              <Text class="text-2xs font-medium text-muted">{t("web.agent.list.defaultBadge")}</Text>
            </View>
          </If>
        </View>
        <Text class="truncate text-xs leading-snug text-muted">{props.agent.duty || t("web.agent.list.orchestratorLine")}</Text>
      </View>
    </RowShell>
  );
}

function WorkerRow(props: {
  agent: Agent;
  defaultAvatar?: string | undefined;
  runtime?: RuntimeInfo | undefined;
  errors: readonly LocalizedAgentProblem[];
  first: boolean;
  wide: boolean;
}) {
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
  const runtimeLabel = createMemo(() => props.runtime?.preset.label ?? props.agent.runtime);
  const runtimeSpec = createMemo(() => [runtimeLabel(), props.agent.model, props.agent.effort].filter(Boolean).join(" · "));
  const toggleAction = () => (props.agent.enabled ? t("web.agent.list.disable") : t("web.agent.list.enable"));
  const toggleLabel = () => t("web.agent.list.toggle", { act: toggleAction(), name: props.agent.name });
  const fixHref = createMemo(() => props.errors.find((e) => e.fixHref !== undefined)?.fixHref);
  const displayLook = createMemo(() => withDefaultWorkerAvatar(props.agent, props.defaultAvatar));
  return (
    <RowShell
      agent={props.agent}
      to={`/agents/${encodeURIComponent(props.agent.id)}`}
      first={props.first}
      wide={props.wide}
      muted={!props.agent.enabled}
      readiness={
        <If when={props.errors.length > 0}>
          <>
            <View tooltip={<Bubble text={props.errors.map((e) => e.text).join("\n")} />} class="max-w-56 shrink rounded-full bg-bad-soft px-2 py-0.5">
              <Text testID="agent-card-error" class="truncate text-2xs font-medium text-berry">
                {t("web.agent.cannot") + (props.errors[0]?.text ?? "")}
              </Text>
            </View>
            <If when={fixHref()}>
              {(href) => (
                <TextLink href={href()} testid={`agent-card-fix-${props.agent.id}`} danger>
                  {t("web.setting.readiness.fix")}
                </TextLink>
              )}
            </If>
          </>
        </If>
      }
      runtimePill={
        <View tooltip={<Bubble text={runtimeSpec()} />} class="h-6 max-w-full flex-row items-center gap-1.5 rounded-md border border-line bg-side px-2">
          <Dot tone={available() ? "leaf" : "berry"} size={6} ring={false} />
          <Text class="min-w-0 truncate text-xs font-medium text-muted">{runtimeLabel()}</Text>
        </View>
      }
      action={
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
      <View class="size-8 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-side">
        <AgentFace agentId={props.agent.id} name={props.agent.name} runtime={props.agent.runtime} look={displayLook()} size={30} muted={!props.agent.enabled} />
      </View>
      <View class="min-w-0 flex-1 gap-0.5">
        <View class="flex-row items-center gap-1.5">
          <Text class="min-w-0 shrink truncate text-sm font-medium text-ink">{props.agent.name}</Text>
          <If when={!props.agent.enabled}>
            <View class="shrink-0 rounded-full bg-hover px-2 py-px">
              <Text class="text-2xs font-medium text-faint">{t("web.agent.list.disabledBadge")}</Text>
            </View>
          </If>
        </View>
        <Text class="truncate text-xs leading-snug text-muted">{props.agent.duty || runtimeSpec()}</Text>
      </View>
    </RowShell>
  );
}
