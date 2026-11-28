import { Text, View, windowSize } from "nsh";
import { Popover } from "nsh/base";

import { t } from "@vibevalley/i18n";
import { IssueStatus as IssueStatusSchema } from "@vibevalley/protocol/schema";

import { Button } from "../../../../design/Button";
import { SearchField, Select } from "../../../../design/Field";
import { Icon } from "../../../../design/Icon";
import { motionClass } from "../../../../design/motion";
import { Segmented } from "../../../../design/Segmented";
import { CountPill } from "../../../../design/Tag";
import { Bubble } from "../../../../design/Tip";
import { createMemo } from "../../../../infra/solid";
import { type BoardCard, type BoardFilter, cardAgent, cardRepo, cardTags, filterAny, noFilter } from "../../model/cards";
import { type BoardLook, boardViews, viewLabel } from "../../model/display";
import { useNameOf } from "../../model/history";
import { issueScopes, issueTagPresets } from "../../model/meta";
import { DisplayMenu } from "../DisplayMenu";

export function IssuesToolbar(props: {
  filter: BoardFilter;
  cards: BoardCard[];
  shown: number;
  onFilter: (f: BoardFilter) => void;
  look: BoardLook;
  onLook: (l: BoardLook) => void;
  refreshing: boolean;
  onRefresh: () => void;
  onNew: () => void;
}) {
  const nameOf = useNameOf();
  const repos = createMemo(() => [...new Set(props.cards.map(cardRepo).filter((p): p is string => !!p))].toSorted());
  const agents = createMemo(() =>
    [...new Set(props.cards.map(cardAgent).filter((a): a is string => !!a))].toSorted((a, b) => nameOf()(a).localeCompare(nameOf()(b))),
  );
  const tags = createMemo(() => {
    const present = props.cards.flatMap(cardTags);
    return [...new Set([...issueTagPresets(), ...present])];
  });
  const repoOptions = createMemo(() => repos().map((p) => ({ value: p, label: p })));
  const agentOptions = createMemo(() => agents().map((a) => ({ value: a, label: nameOf()(a) })));
  const tagOptions = createMemo(() => tags().map((tag) => ({ value: tag, label: tag })));
  const statusOptions = createMemo(() => {
    const base: { value: string; label: string }[] = IssueStatusSchema.options.map((s) => ({ value: s, label: t(`shared.status.${s}`) }));
    if (props.filter.status === "todo,in_progress") {
      return [{ value: "todo,in_progress", label: t("web.issue.page.todoAndInProgress") }, ...base];
    }
    return base;
  });
  const scopeOptions = createMemo(() =>
    issueScopes.map((s) => ({
      value: s,
      label: t(`web.issue.scope.${s}`),
    })),
  );
  const isFiltered = createMemo(() => filterAny(props.filter));
  const narrowToolbar = () => windowSize().width < 768;
  const wideScope = () => windowSize().width >= 1100;
  const facetFilterCount = createMemo(
    () => Number(props.filter.repo !== "") + Number(props.filter.agent !== "") + Number(props.filter.tag !== "") + Number(props.filter.status !== ""),
  );
  const popoverFilterCount = createMemo(() => facetFilterCount() + Number(!wideScope() && props.filter.scope !== "all"));

  const filterPopover = () => (
    <Popover
      placement="bottom"
      align="start"
      offset={6}
      popupClass="w-72 gap-2.5 rounded-lg border border-line bg-elevated p-3 shadow-float"
      popupStyle={{ maxWidth: Math.max(240, windowSize().width - 24) }}
      trigger={
        <View
          testID="issue-filter-popover"
          role="button"
          accessibilityLabel={t("web.issue.page.filter")}
          tooltip={<Bubble text={t("web.issue.page.filter")} />}
          class={`h-7 shrink-0 flex-row items-center gap-1.5 rounded-md border border-line px-2.5 ${
            popoverFilterCount() > 0 ? "bg-selected" : "bg-page hover:bg-hover"
          } ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px`}
        >
          <Icon name="filter" size={14} tone={popoverFilterCount() > 0 ? "accent" : "muted"} />
          <Text class="whitespace-nowrap text-sm text-ink">{t("web.issue.page.filter")}</Text>
          <If when={popoverFilterCount() > 0}>
            <CountPill count={popoverFilterCount()} active />
          </If>
        </View>
      }
    >
      <View testID="issue-filter-popover-menu" accessibilityLabel={t("web.issue.page.filter")} class="gap-2.5">
        <If when={!wideScope()}>
          <View class="gap-1">
            <Text class="text-xs font-medium text-muted">{t("web.issue.scope.label")}</Text>
            <Segmented
              label={t("web.issue.scope.label")}
              testid="issue-scope"
              block
              value={props.filter.scope}
              onChange={(scope) => props.onFilter({ ...props.filter, scope })}
              options={scopeOptions()}
            />
          </View>
        </If>
        <View class="gap-1">
          <Text class="text-xs font-medium text-muted">{t("web.issue.page.byRepo")}</Text>
          <Select
            size="control"
            class="w-full"
            label={t("web.issue.page.byRepo")}
            testid="filter-repo"
            filter
            value={props.filter.repo}
            placeholder={t("web.issue.page.allRepos")}
            options={repoOptions()}
            onChange={(repo) => props.onFilter({ ...props.filter, repo })}
          />
        </View>
        <View class="gap-1">
          <Text class="text-xs font-medium text-muted">{t("web.issue.page.byHelper")}</Text>
          <Select
            size="control"
            class="w-full"
            label={t("web.issue.page.byHelper")}
            testid="filter-agent"
            filter
            value={props.filter.agent}
            placeholder={t("web.issue.page.allHelpers")}
            options={agentOptions()}
            onChange={(agent) => props.onFilter({ ...props.filter, agent })}
          />
        </View>
        <View class="gap-1">
          <Text class="text-xs font-medium text-muted">{t("web.issue.tags.byTag")}</Text>
          <Select
            size="control"
            class="w-full"
            label={t("web.issue.tags.byTag")}
            testid="filter-tag"
            filter
            value={props.filter.tag}
            placeholder={t("web.issue.tags.allTags")}
            options={tagOptions()}
            onChange={(tag) => props.onFilter({ ...props.filter, tag })}
          />
        </View>
        <View class="gap-1">
          <Text class="text-xs font-medium text-muted">{t("web.issue.page.byStatus")}</Text>
          <Select
            size="control"
            class="w-full"
            label={t("web.issue.page.byStatus")}
            testid="filter-status"
            filter
            value={props.filter.status}
            placeholder={t("web.issue.page.allStatuses")}
            options={statusOptions()}
            onChange={(status) => props.onFilter({ ...props.filter, status })}
          />
        </View>
        <If when={isFiltered()}>
          <View class="flex-row items-center justify-between gap-2 border-t border-line pt-2">
            <Text class="text-xs text-muted tabular-nums">{t("web.issue.page.shown", { shown: props.shown, of: props.cards.length })}</Text>
            <Button size="compact" tone="quiet" testID="filter-popover-clear" onPress={() => props.onFilter(noFilter)}>
              {t("web.issue.page.clear")}
            </Button>
          </View>
        </If>
      </View>
    </Popover>
  );

  const viewSwitcher = () => (
    <Segmented
      label={t("web.issue.page.view")}
      testid="issue-view"
      value={props.look.view}
      onChange={(view) => props.onLook({ ...props.look, view })}
      options={boardViews.map((v) => ({ value: v, label: viewLabel[v] }))}
    />
  );

  const refreshButton = () => (
    <View
      role="button"
      testID="issue-refresh"
      accessibilityLabel={props.refreshing ? t("web.issue.page.refreshing") : t("web.issue.page.refresh")}
      accessibilityState={{ busy: props.refreshing }}
      tooltip={<Bubble text={props.refreshing ? t("web.issue.page.refreshing") : t("web.issue.page.refresh")} />}
      onPress={() => props.onRefresh()}
      class={`h-7 shrink-0 flex-row items-center justify-center gap-1 rounded-md ${
        props.refreshing ? "bg-selected px-2" : "w-7 hover:bg-hover"
      } ${motionClass("transition-transform duration-120 ease-out")} active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus`}
    >
      <View class={props.refreshing ? motionClass("animate-spin") : ""}>
        <Icon name="refresh" size={14} tone={props.refreshing ? "water" : "muted"} />
      </View>
      <If when={props.refreshing}>
        <Text testID="issue-syncing" class="whitespace-nowrap text-xs font-medium text-water">
          {t("web.issue.page.refreshing")}
        </Text>
      </If>
    </View>
  );

  const newButton = () => (
    <View class="shrink-0" tooltip={<Bubble text={`${t("web.issue.new.title")} (C)`} />}>
      <Button tone="primary" icon="add" testID="issue-toolbar-new" onPress={props.onNew}>
        {t("web.issue.new.card")}
      </Button>
    </View>
  );

  const clearButton = () => (
    <If when={isFiltered()}>
      <View
        role="button"
        testID="filter-clear"
        onPress={() => props.onFilter(noFilter)}
        class={`h-7 shrink-0 flex-row items-center rounded-md px-2 ${motionClass("transition-transform duration-120 ease-out")} hover:bg-hover active:translate-y-px`}
      >
        <Text class="whitespace-nowrap text-xs font-medium text-water">{t("web.issue.page.clear")}</Text>
      </View>
    </If>
  );

  return (
    <If
      when={!narrowToolbar()}
      else={
        <View testID="issues-toolbar" desktop={{ windowDrag: true }} class="shrink-0 flex-col border-b border-line bg-page px-3">
          <View class="h-10 flex-row items-center gap-1.5">
            <SearchField
              testid="issue-search"
              clearTestid="issue-search-clear"
              value={props.filter.query}
              onInput={(query) => props.onFilter({ ...props.filter, query })}
              placeholder={t("web.issue.page.find")}
              label={t("web.issue.page.findLabel")}
              class="min-w-0 flex-1"
            />
            {filterPopover()}
            {clearButton()}
            {refreshButton()}
            {newButton()}
          </View>
          <View class="h-9 flex-row items-center justify-between gap-2 border-t border-line">
            <View class="min-w-0 shrink-0">{viewSwitcher()}</View>
            <View class="shrink-0">
              <DisplayMenu look={props.look} onChange={props.onLook} />
            </View>
          </View>
        </View>
      }
    >
      <View testID="issues-toolbar" desktop={{ windowDrag: true }} class="h-11 shrink-0 flex-row items-center gap-2 border-b border-line bg-page px-4">
        <View class="min-w-0 flex-1 flex-row items-center gap-2">
          <If when={wideScope()}>
            <Segmented
              label={t("web.issue.scope.label")}
              testid="issue-scope"
              value={props.filter.scope}
              onChange={(scope) => props.onFilter({ ...props.filter, scope })}
              options={scopeOptions()}
            />
          </If>
          <SearchField
            testid="issue-search"
            clearTestid="issue-search-clear"
            value={props.filter.query}
            onInput={(query) => props.onFilter({ ...props.filter, query })}
            placeholder={t("web.issue.page.find")}
            label={t("web.issue.page.findLabel")}
            class="min-w-20 max-w-44 flex-1"
          />
          {filterPopover()}
          <If when={wideScope() && isFiltered()}>
            <Text class="shrink-0 whitespace-nowrap text-xs text-muted tabular-nums">
              {t("web.issue.page.shown", { shown: props.shown, of: props.cards.length })}
            </Text>
          </If>
          {clearButton()}
        </View>
        <View class="ml-auto shrink-0 flex-row items-center gap-1.5">
          {viewSwitcher()}
          <DisplayMenu look={props.look} onChange={props.onLook} />
          {refreshButton()}
          {newButton()}
        </View>
      </View>
    </If>
  );
}
