import { computed, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { IssueStatus } from "@vibevalley/protocol";

import { Button } from "../../../design/Button";
import { OrchestratorFace } from "../../../design/domain/Face";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { ActiveBar } from "../../../design/layout";
import { motionDuration, motionOff } from "../../../design/motion";
import { CountPill } from "../../../design/Tag";
import { Bubble } from "../../../design/Tip";
import { useOrchestrators } from "../../../infra/agents";
import { ago } from "../../../infra/base/format";
import { type BoardCard, cardAgent, cardLook, cardRepo, closedShown, laneLabel, laneStatus } from "../model/cards";
import { type Grouping, groupRows, laneOrder, type Ordering, orderRows, type RowGroup, rowKeys } from "../model/display";
import { useIssues, useNameOf } from "../model/history";
import { EmptyNote, OlderLink } from "./Board";
import { AgentFaceOf, CardFace, FlagChip, NoFaceMark, PriorityMark, ProgressMark, StatusMark } from "./Marks";
import type { NewIssueAt } from "./NewIssue";
import { useWidth } from "./Sheet";

/** The quick add, with the group's repo or helper when grouped by one. */
export type ListAdd = (where: NewIssueAt) => void;

/** The issues as rows, grouped as the user picked: Linear's list. A row opens the issue as a card does. */
export function IssueList(props: {
  cards: BoardCard[];
  filtered?: boolean | undefined;
  loading: boolean;
  selected?: string | undefined;
  older: boolean;
  grouping: Grouping;
  ordering: Ordering;
  onOlder: () => void;
  onOpen: (id: string) => void;
  onAdd: ListAdd;
  onClearFilter?: (() => void) | undefined;
}) {
  const folded = signal<ReadonlySet<string>>(new Set());
  const nameOf = useNameOf();
  const orchestrators = useOrchestrators();
  const orchestratorIds = computed(() => new Set(orchestrators().map((a) => a.id)));
  const isOrchestrator = (id: string) => orchestratorIds().has(id);
  const box = useWidth();
  const wide = computed(() => box.width() === 0 || box.width() >= 640);
  const groups = computed(() => groupRows(props.cards, props.grouping, rowKeys));

  // Only where a new todo belongs: the todo group, a repo's, a helper's (not the orchestrator's), or the one group.
  const canAdd = (g: RowGroup<BoardCard>) => (props.grouping === "status" ? g.lane === "todo" : props.grouping === "agent" ? !isOrchestrator(g.key) : true);
  const add = (g: RowGroup<BoardCard>) => props.onAdd(props.grouping === "repo" ? { repo: g.key } : props.grouping === "agent" ? { agent: g.key } : {});
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
          <View class="px-3 pb-4">
            <Each of={groups()} key={(g) => g.key}>
              {(g) => {
                const groupLane = computed(() => g().lane);
                const ordered = computed(() => {
                  const l = groupLane();
                  return l ? laneOrder(l, g().rows, props.ordering) : orderRows(g().rows, props.ordering, rowKeys);
                });
                const folding = computed(() => groupLane() === "closed" && !props.older && ordered().length > closedShown);
                const rows = computed(() => (folding() ? ordered().slice(0, closedShown) : ordered()));
                const hidden = computed(() => (folding() ? ordered().length - closedShown : 0));
                const isFolded = computed(() => folded().has(g().key));
                const label = computed(() => {
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
                  <View accessibilityLabel={label()} testID="issue-group" class="mb-1.5">
                    {/* A head of words on the page, not a bar: its line under it sets the group off. */}
                    <View class="mt-2 h-8.5 flex-row items-center rounded-t-md border-b border-line bg-page pr-1 hover:bg-hover">
                      <View
                        role="button"
                        testID={`issue-group-${g().key || "none"}`}
                        onPress={() => fold(g().key)}
                        accessibilityLabel={isFolded() ? t("web.issue.list.unfold", { group: label() }) : t("web.issue.list.fold", { group: label() })}
                        class="h-full min-w-0 flex-1 flex-row items-center gap-2 px-2.5"
                      >
                        <View
                          class="w-4 shrink-0 items-center justify-center"
                          style={{
                            transform: [{ rotate: isFolded() ? "0deg" : "90deg" }],
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
                        <Text class="truncate text-sm font-semibold text-ink">{label()}</Text>
                        <CountPill count={g().rows.length} />
                      </View>
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
                    <If when={!isFolded()}>
                      <View class="mt-0.5 gap-px">
                        <Each of={rows()} key={(c) => c.id}>
                          {(c) => {
                            const l = groupLane();
                            return (
                              <Row
                                card={c()}
                                wide={wide()}
                                selected={c().id === props.selected}
                                showRepo={props.grouping !== "repo"}
                                groupStatus={props.grouping === "status" && l ? laneStatus[l] : undefined}
                                onOpen={props.onOpen}
                                nameOf={nameOf()}
                              />
                            );
                          }}
                        </Each>
                        <If when={hidden() > 0 || (groupLane() === "closed" && props.older && g().rows.length > closedShown)}>
                          <View class="pt-1">
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
  wide: boolean;
  selected: boolean;
  showRepo: boolean;
  /** The status the group stands for, when grouped by it: a row says its own only when it differs. */
  groupStatus?: IssueStatus | undefined;
  onOpen: (id: string) => void;
  nameOf: (id: string) => string;
}) {
  const issues = useIssues();
  const now = () => Date.now();
  const look = computed(() => cardLook(props.card, props.nameOf, issues(), now()));
  const repo = computed(() => cardRepo(props.card));
  const shownFlags = computed(() => (props.wide ? look().flags : look().flags.slice(0, 1)));
  const attachmentCount = computed(() => props.card.issue.attachments?.length ?? 0);
  const hasTrailingMarks = computed(() => Boolean(look().progress) || shownFlags().length > 0 || attachmentCount() > 0);
  return (
    <View
      role="button"
      testID="issue-card"
      ref={(el) => {
        if (props.selected)
          requestAnimationFrame(() => {
            el.reveal({ vertical: "nearest" });
            el.focus();
          });
      }}
      accessibilityLabel={look().title}
      accessibilityState={{ selected: props.selected }}
      tooltip={<If when={look().detail}>{(d) => <Bubble text={d()} />}</If>}
      onPress={() => props.onOpen(props.card.id)}
      class={`relative min-h-9.5 flex-row items-center gap-2.5 rounded-md px-2.5 py-1.5 focus-visible:outline-2 focus-visible:outline-focus ${props.selected ? "bg-selected" : "hover:bg-hover"}`}
    >
      <If when={props.selected}>
        <ActiveBar />
      </If>
      <View class="w-4 shrink-0 items-center justify-center">
        <If when={look().priority === "urgent" || look().priority === "high" ? look().priority : undefined}>
          {(pr) => <PriorityMark priority={pr()} size={13} />}
        </If>
      </View>
      <If when={props.wide}>
        <Text class="w-11 shrink-0 truncate font-mono text-xs text-muted" style={{ fontVariant: ["tabular-nums"] }}>
          {look().number ?? ""}
        </Text>
      </If>
      <View class="w-4 shrink-0 items-center justify-center">
        <If when={props.groupStatus === undefined || (look().status !== props.groupStatus && !(props.groupStatus === "todo" && look().status === "backlog"))}>
          <StatusMark status={look().status} tone={look().statusTone} size={13} />
        </If>
      </View>
      <View class="min-w-0 flex-1 gap-0.5">
        <Text class="truncate text-sm font-medium text-ink">{look().title}</Text>
        <If when={look().wait}>{(wait) => <Text class="truncate text-xs text-water">{wait()}</Text>}</If>
      </View>
      <If when={hasTrailingMarks()}>
        <View class="shrink-0 flex-row items-center gap-1.5">
          <If when={look().progress}>{(pg) => <ProgressMark done={pg().done} total={pg().total} />}</If>
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
      <If when={props.showRepo && props.wide}>
        <Text class="w-28 shrink-0 truncate text-xs text-muted">{repo() ?? ""}</Text>
      </If>
      <View class="w-5 shrink-0 items-center justify-center">
        <If when={cardAgent(props.card) || props.card.kind === "orchestrator"}>
          <CardFace card={props.card} size={18} />
        </If>
      </View>
      <Text class={`${props.wide ? "w-16" : "w-13"} shrink-0 text-right text-xs text-faint`} style={{ fontVariant: ["tabular-nums"] }}>
        {ago(rowKeys(props.card).updatedAt, now())}
      </Text>
    </View>
  );
}
