import { computed, Scroll, signal, Text, View, windowSize, type ViewRef } from "nsh";

import { t } from "@vibevalley/i18n";
import type { ActorRef, Issue } from "@vibevalley/protocol";

import { Button } from "../../../design/Button";
import { Checkbox } from "../../../design/Checkbox";
import { OrchestratorFace } from "../../../design/domain/Face";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { ActiveBar } from "../../../design/layout";
import { motionDuration, motionOff } from "../../../design/motion";
import { CountPill } from "../../../design/Tag";
import { Bubble } from "../../../design/Tip";
import { mix } from "../../../design/tone";
import { useOrchestrators } from "../../../infra/agents";
import { ago } from "../../../infra/base/format";
import { createEffect } from "../../../infra/solid";
import { type BoardCard, cardAgent, cardLook, cardRepo, closedShown, laneLabel, laneStatus } from "../model/cards";
import {
  type BoardDensity,
  defaultFields,
  formatCompactDateLabel,
  type GroupBy,
  groupCards,
  type Grouping,
  groupRows,
  type HierarchyMode,
  type IssueFieldVisibility,
  laneOrder,
  type Ordering,
  orderRows,
  type RowGroup,
  rowKeys,
} from "../model/display";
import { useIssues, useNameOf } from "../model/history";
import { blockerIssuesOf, childIssuesOf } from "../model/meta";
import { EmptyNote, OlderLink } from "./Board";
import { BlockedByChips, CardChildRows, IssueGroupHeader, OwnerMark, ParentBadge, TagPills, useGroupLabel } from "./IssueMetaControls";
import { AgentFaceOf, CardFace, FlagChip, NoFaceMark, PriorityMark, ProgressMark, StatusMark } from "./Marks";
import type { NewIssueAt } from "./NewIssue";
import { useWidth } from "./Sheet";

/** The quick add, with the group's repo or helper when grouped by one. */
export type ListAdd = (where: NewIssueAt) => void;

interface ListGroupSection {
  key: string;
  lane?: RowGroup<BoardCard>["lane"];
  rows: BoardCard[];
  owner?: ActorRef | undefined;
  priority?: Issue["priority"] | undefined;
  parent?: Issue | undefined;
}

/** The issues as rows, grouped as the user picked: Linear's list. A row opens the issue as a card does. */
export function IssueList(props: {
  cards: BoardCard[];
  allIssues?: readonly Issue[] | undefined;
  filtered?: boolean | undefined;
  loading: boolean;
  selected?: string | undefined;
  selectedIds?: ReadonlySet<string> | undefined;
  older: boolean;
  grouping: Grouping;
  groupBy?: GroupBy | undefined;
  hierarchy?: HierarchyMode | undefined;
  ordering: Ordering;
  density?: BoardDensity | undefined;
  fields?: IssueFieldVisibility | undefined;
  onOlder: () => void;
  onOpen: (id: string) => void;
  onToggleSelect?: ((id: string, opts: { range: boolean }) => void) | undefined;
  onAdd: ListAdd;
  onClearFilter?: (() => void) | undefined;
}) {
  const folded = signal<ReadonlySet<string>>(new Set());
  const issues = useIssues();
  const resolvedIssues = computed(() => [...(props.allIssues ?? issues())]);
  const nameOf = useNameOf();
  const groupLabel = useGroupLabel();
  const orchestrators = useOrchestrators();
  const orchestratorIds = computed(() => new Set(orchestrators().map((a) => a.id)));
  const isOrchestrator = (id: string) => orchestratorIds().has(id);
  const box = useWidth();
  const wide = computed(() => box.width() === 0 || box.width() >= 640);
  const showParentTitle = computed(() => (box.width() === 0 ? windowSize().width >= 1080 : box.width() >= 1000));
  const compact = computed(() => props.density === "compact");
  const activeGroupBy = computed<GroupBy>(() => props.groupBy ?? "none");
  const groups = computed<ListGroupSection[]>(() => {
    const gb = activeGroupBy();
    if (gb !== "none") {
      return groupCards(props.cards, gb, resolvedIssues()).map((g) => ({
        key: g.key,
        rows: g.cards,
        owner: g.owner,
        priority: g.priority,
        parent: g.parent,
      }));
    }
    return groupRows(props.cards, props.grouping, rowKeys);
  });

  // Only where a new todo belongs: the backlog/todo group, a repo's, a helper's (not the orchestrator's), or the one group.
  const canAdd = (g: ListGroupSection) => {
    const gb = activeGroupBy();
    if (gb !== "none") {
      if (gb === "agent") return g.key !== "" && !isOrchestrator(g.key);
      return true;
    }
    return props.grouping === "status" ? g.lane === "backlog" || g.lane === "todo" : props.grouping === "agent" ? !isOrchestrator(g.key) : true;
  };
  const add = (g: ListGroupSection) => {
    const gb = activeGroupBy();
    if (gb !== "none") {
      props.onAdd(
        gb === "repo"
          ? { repo: g.key }
          : gb === "agent"
            ? { agent: g.key }
            : gb === "owner" && g.owner
              ? { owner: g.owner }
              : gb === "parent" && g.key
                ? { parent: g.key }
                : {},
      );
      return;
    }
    props.onAdd(props.grouping === "repo" ? { repo: g.key } : props.grouping === "agent" ? { agent: g.key } : {});
  };
  const fold = (key: string) => {
    const n = new Set(folded());
    if (n.has(key)) n.delete(key);
    else n.add(key);
    folded.set(n);
  };

  return (
    <If when={!props.loading} else={<EmptyNote>{t("web.issue.reading")}</EmptyNote>}>
      <Scroll testID="issue-list" class="min-h-0 flex-1" onLayout={box.onLayout}>
        <If
          when={props.cards.length > 0}
          else={
            <View testID="issue-list-empty" class="items-start gap-2 px-5 py-6">
              <Text class="text-xs text-muted">{props.filtered === true ? t("web.issue.list.emptyFiltered") : t("web.issue.list.empty")}</Text>
              <If when={props.filtered === true ? props.onClearFilter : undefined}>
                {(clear) => (
                  <Button size="compact" tone="plain" icon="close" testID="issue-list-clear-filter" onPress={() => clear()()}>
                    {t("web.issue.page.clear")}
                  </Button>
                )}
              </If>
            </View>
          }
        >
          <View class={compact() ? "px-3 py-2" : "px-4 py-3"}>
            <Each of={groups()} key={(g) => g.key}>
              {(g) => {
                const groupLane = computed(() => g().lane);
                const ordered = computed(() => {
                  const l = groupLane();
                  return l ? laneOrder(l, g().rows, props.ordering) : orderRows(g().rows, props.ordering, rowKeys);
                });
                const isClosed = computed(() => groupLane() === "done" || groupLane() === "canceled");
                const folding = computed(() => isClosed() && !props.older && ordered().length > closedShown);
                const rows = computed(() => (folding() ? ordered().slice(0, closedShown) : ordered()));
                const hidden = computed(() => (folding() ? ordered().length - closedShown : 0));
                const isFolded = computed(() => folded().has(g().key));
                const showOlder = computed(() => hidden() > 0 || (isClosed() && props.older && g().rows.length > closedShown));
                const isEmpty = computed(() => rows().length === 0 && !showOlder());
                const showBody = computed(() => !isFolded() && !isEmpty());
                const label = computed(() => {
                  const gb = activeGroupBy();
                  if (gb !== "none") return groupLabel()(gb, g().key, g().parent, g().owner);
                  const l = groupLane();
                  return props.grouping === "status" && l
                    ? laneLabel[l]
                    : props.grouping === "repo"
                      ? g().key || t("web.issue.list.noRepo")
                      : props.grouping === "agent"
                        ? g().key
                          ? nameOf()(g().key)
                          : t("web.issue.noHelper")
                        : t("web.issue.list.all");
                });
                return (
                  <View
                    accessibilityLabel={label()}
                    testID="issue-group"
                    class={`${compact() ? "mb-2" : "mb-3"} overflow-hidden rounded-lg border border-line bg-page ${isEmpty() ? "opacity-75" : ""}`}
                  >
                    <View
                      class={`${compact() ? "h-7" : "h-8.5"} flex-row items-center pr-1.5 ${
                        isEmpty() ? "rounded-lg bg-page" : showBody() ? "border-b border-line bg-side" : "rounded-lg bg-side"
                      }`}
                    >
                      <If
                        when={activeGroupBy() !== "none"}
                        else={
                          <View
                            role="button"
                            testID={`issue-group-${g().key || "none"}`}
                            onPress={() => fold(g().key)}
                            accessibilityLabel={isFolded() ? t("web.issue.list.unfold", { group: label() }) : t("web.issue.list.fold", { group: label() })}
                            accessibilityState={{ expanded: showBody() }}
                            class="h-full min-w-0 flex-1 flex-row items-center gap-2 px-2.5 hover:bg-hover"
                          >
                            <View
                              class="w-4 shrink-0 items-center justify-center"
                              style={{
                                transform: [{ rotate: showBody() ? "90deg" : "0deg" }],
                                ...(motionOff() ? {} : { transitionProperty: "transform", transitionDuration: motionDuration(120) }),
                              }}
                            >
                              <Icon name="expand" size={10} tone="muted" />
                            </View>
                            <If when={props.grouping !== "none"}>
                              <View class="w-4 shrink-0 items-center justify-center">
                                <If when={props.grouping === "status" ? groupLane() : undefined}>{(l) => <StatusMark status={laneStatus[l()]} size={14} />}</If>
                                <If when={props.grouping === "repo"}>
                                  <Icon name="folder" size={14} tone="muted" />
                                </If>
                                <If when={props.grouping === "agent"}>
                                  <If when={g().key} else={<NoFaceMark size={14} />}>
                                    {(key) => (
                                      <If when={isOrchestrator(key())} else={<AgentFaceOf agent={key()} size={16} />}>
                                        <OrchestratorFace size={16} agent={key()} />
                                      </If>
                                    )}
                                  </If>
                                </If>
                              </View>
                            </If>
                            <Text class={`truncate text-xs font-semibold ${isEmpty() ? "text-muted" : "text-ink"}`}>{label()}</Text>
                            <CountPill count={g().rows.length} />
                          </View>
                        }
                      >
                        <IssueGroupHeader
                          testid={`issue-group-${g().key || "none"}`}
                          label={label()}
                          count={g().rows.length}
                          expanded={showBody()}
                          empty={isEmpty()}
                          groupBy={activeGroupBy()}
                          groupKey={g().key}
                          owner={g().owner}
                          priority={g().priority}
                          onToggle={() => fold(g().key)}
                        />
                      </If>
                      <If when={canAdd(g())}>
                        <IconButton
                          testid="issue-group-add"
                          icon="add"
                          size={14}
                          label={t("web.issue.list.writeIn", { group: label() })}
                          onClick={() => add(g())}
                        />
                      </If>
                    </View>
                    <If when={showBody()}>
                      <View testID="issue-group-body">
                        <Each of={rows()} key={(c) => c.id}>
                          {(c, i) => (
                            <Row
                              card={c()}
                              allIssues={resolvedIssues()}
                              hierarchy={props.hierarchy}
                              density={props.density}
                              fields={props.fields}
                              wide={wide()}
                              showParentTitle={showParentTitle()}
                              selected={c().id === props.selected}
                              checked={props.selectedIds?.has(c().id) === true}
                              selectionActive={(props.selectedIds?.size ?? 0) > 0}
                              showRepo={activeGroupBy() !== "repo" && props.grouping !== "repo"}
                              divider={i() < rows().length - 1 || showOlder()}
                              onOpen={props.onOpen}
                              onToggleSelect={props.onToggleSelect}
                              nameOf={nameOf()}
                            />
                          )}
                        </Each>
                        <If when={showOlder()}>
                          <View class="py-1.5">
                            <OlderLink hidden={hidden()} onClick={props.onOlder} />
                          </View>
                        </If>
                      </View>
                    </If>
                  </View>
                );
              }}
            </Each>
          </View>
        </If>
      </Scroll>
    </If>
  );
}

function Row(props: {
  card: BoardCard;
  allIssues?: readonly Issue[] | undefined;
  hierarchy?: HierarchyMode | undefined;
  density?: BoardDensity | undefined;
  fields?: IssueFieldVisibility | undefined;
  wide: boolean;
  showParentTitle: boolean;
  selected: boolean;
  checked?: boolean | undefined;
  selectionActive?: boolean | undefined;
  showRepo: boolean;
  divider: boolean;
  onOpen: (id: string) => void;
  onToggleSelect?: ((id: string, opts: { range: boolean }) => void) | undefined;
  nameOf: (id: string) => string;
}) {
  const issues = useIssues();
  const resolvedIssues = computed(() => [...(props.allIssues ?? issues())]);
  const now = () => Date.now();
  const look = computed(() => cardLook(props.card, props.nameOf, resolvedIssues(), now()));
  const repo = computed(() => cardRepo(props.card));
  const fields = computed(() => props.fields ?? defaultFields);
  const compact = computed(() => props.density === "compact");
  const shownFlags = computed(() => (props.wide ? look().flags : look().flags.slice(0, 1)));
  const parentIssue = computed(() => (props.card.issue.parent ? resolvedIssues().find((item) => item.id === props.card.issue.parent) : undefined));
  const blockerIssues = computed(() => blockerIssuesOf(props.card.issue, resolvedIssues()));
  const childIssues = computed(() =>
    props.hierarchy === "top_level" || props.hierarchy === "parents_only" ? childIssuesOf(props.card.issue.id, resolvedIssues()) : [],
  );
  const tags = computed(() => (fields().tags ? (props.card.issue.tags ?? []) : []));
  const showProgress = computed(() => (fields().progress ? look().progress : undefined));
  const dateLabel = computed(() => (fields().dates ? formatCompactDateLabel(props.card.issue) : undefined));
  const showAgent = computed(() => fields().agent && (Boolean(cardAgent(props.card)) || props.card.kind === "orchestrator"));
  const showOwner = computed(() => {
    if (!fields().owner || props.card.issue.owner === undefined) return false;
    if (showAgent() && props.card.issue.owner.kind === "agent" && props.card.issue.owner.id === cardAgent(props.card)) return false;
    return true;
  });
  const attachmentCount = computed(() => props.card.issue.attachments?.length ?? 0);
  const hasTrailingMarks = computed(
    () =>
      Boolean(showProgress()) || blockerIssues().length > 0 || tags().length > 0 || Boolean(dateLabel()) || shownFlags().length > 0 || attachmentCount() > 0,
  );
  let rowEl: ViewRef | undefined;
  createEffect(
    () => props.selected,
    (sel) => {
      if (sel && rowEl) {
        requestAnimationFrame(() => {
          rowEl?.reveal({ vertical: "nearest" });
        });
      }
    },
    { defer: true },
  );
  return (
    <View class={props.divider ? "border-b" : undefined} style={props.divider ? { borderColor: mix("line", 0.55) } : undefined}>
      <View
        role="button"
        testID="issue-card"
        ref={(el) => {
          rowEl = el;
          if (props.selected)
            requestAnimationFrame(() => {
              el.reveal({ vertical: "nearest" });
              el.focus();
            });
        }}
        accessibilityLabel={look().title}
        accessibilityState={{ selected: props.selected || props.checked === true }}
        onPress={(e) => {
          if (e.modifiers.shift && props.onToggleSelect) {
            props.onToggleSelect(props.card.id, { range: true });
            return;
          }
          props.onOpen(props.card.id);
        }}
        class={`group relative flex-row items-center ${compact() ? "min-h-7.5 gap-2 px-2 py-1" : "min-h-9.5 gap-2.5 px-2.5 py-1.5"} focus-visible:outline-2 focus-visible:outline-focus ${
          props.checked === true || props.selected ? "bg-selected" : "hover:bg-hover"
        }`}
      >
        <If when={props.selected || props.checked === true}>
          <ActiveBar />
        </If>
        <If when={props.onToggleSelect}>
          {(onToggle) => (
            <View class={props.checked === true || props.selectionActive === true ? "shrink-0" : "shrink-0 opacity-0 group-hover:opacity-100"}>
              <Checkbox
                testid={`issue-select-${props.card.id}`}
                label={t("web.issue.triage.selectIssue", { n: props.card.issue.number })}
                checked={props.checked === true}
                onChange={() => onToggle()(props.card.id, { range: false })}
              />
            </View>
          )}
        </If>
        <If when={fields().priority}>
          <View class="w-4 shrink-0 items-center justify-center">
            <If when={look().priority === "urgent" || look().priority === "high" ? look().priority : undefined}>
              {(pr) => <PriorityMark priority={pr()} size={13} />}
            </If>
          </View>
        </If>
        <View class="w-4 shrink-0 items-center justify-center">
          <StatusMark status={look().status} tone={look().statusTone} size={13} />
        </View>
        <If when={props.wide && fields().number}>
          <Text class="w-11 shrink-0 truncate font-mono text-xs text-faint tabular-nums">{look().number ?? ""}</Text>
        </If>
        <View class="min-w-0 flex-1 gap-0.5 overflow-hidden">
          <View class="min-w-0 flex-row items-center gap-1.5 overflow-hidden">
            <Text class={`min-w-0 shrink truncate ${compact() ? "text-xs" : "text-sm"} font-medium text-ink`}>{look().title}</Text>
            <If when={parentIssue()}>
              {(p) => (
                <View class="min-w-0 max-w-44 shrink overflow-hidden">
                  <ParentBadge parent={p()} showTitle={props.showParentTitle} onOpen={props.onOpen} testid="row-parent-badge" />
                </View>
              )}
            </If>
          </View>
          <If when={look().wait}>{(wait) => <Text class="truncate text-xs text-water">{wait()}</Text>}</If>
        </View>
        <If when={hasTrailingMarks()}>
          <View class="shrink-0 flex-row items-center gap-1.5">
            <BlockedByChips blockers={blockerIssues()} max={props.wide ? 2 : 1} onOpen={props.onOpen} testid="row-blocked-by" />
            <TagPills tags={tags()} max={props.wide ? 3 : 1} testid="row-tags" />
            <If when={showProgress()}>{(pg) => <ProgressMark done={pg().done} total={pg().total} />}</If>
            <If when={dateLabel()}>
              {(dt) => (
                <View testID="row-date" class="flex-row items-center gap-0.5 rounded-sm bg-side px-1 py-px">
                  <Icon name="calendar" size={10} tone="muted" />
                  <Text class="font-mono text-2xs text-faint tabular-nums">{dt()}</Text>
                </View>
              )}
            </If>
            <If when={attachmentCount() > 0}>
              <View
                testID="row-attachments"
                accessibilityLabel={t("web.issue.attachments.count", { n: attachmentCount() })}
                tooltip={<Bubble text={t("web.issue.attachments.count", { n: attachmentCount() })} />}
                class="flex-row items-center gap-0.5"
              >
                <Icon name="attach" size={12} tone="muted" />
                <Text class="text-2xs text-muted tabular-nums">{String(attachmentCount())}</Text>
              </View>
            </If>
            <Each of={shownFlags()} key={(f) => `${f.tone}:${f.text}`}>
              {(f) => <FlagChip text={f().text} tone={f().tone} />}
            </Each>
          </View>
        </If>
        <If when={props.showRepo && props.wide && fields().repo}>
          <View class="w-28 shrink-0 flex-row justify-end">
            <If when={repo()}>
              {(r) => (
                <View class="max-w-28 rounded-sm bg-side px-1.5 py-0.5">
                  <Text class="truncate text-2xs text-muted">{r()}</Text>
                </View>
              )}
            </If>
          </View>
        </If>
        <If when={showOwner() ? props.card.issue.owner : undefined}>
          {(owner) => (
            <View testID="row-owner" class="max-w-44 shrink-0 flex-row items-center justify-center">
              <OwnerMark owner={owner()} size={15} showIdentity={owner().kind === "agent"} showMode={props.wide && owner().kind === "agent"} />
            </View>
          )}
        </If>
        <If when={fields().agent}>
          <View class="max-w-36 shrink-0 flex-row items-center justify-center">
            <If when={showAgent()}>
              <CardFace card={props.card} size={18} showIdentity />
            </If>
          </View>
        </If>
        <If when={fields().dates}>
          <Text testID="row-updated-at" class="w-14 shrink-0 text-right text-2xs text-faint tabular-nums">
            {ago(rowKeys(props.card).updatedAt, now())}
          </Text>
        </If>
      </View>
      <If when={childIssues().length > 0}>
        <View class="px-2.5 pb-2">
          <CardChildRows children={childIssues()} onOpenChild={props.onOpen} />
        </View>
      </If>
    </View>
  );
}
