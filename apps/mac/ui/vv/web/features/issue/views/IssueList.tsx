// Ported from VibeValley apps/web/src/features/issue/views/IssueList.tsx:
// Linear's list, grouped as picked. The group heads are not sticky (nsh's
// Scroll has no sticky children yet); the @container breakpoint (640px:
// number, repo and the second flag show) is the list's laid-out width.
import { Scroll, signal, Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import type { IssueStatus } from "@vibevalley/protocol";

import { ago } from "../../../base/format";
import { useOrchestrators } from "../../../infra/agents";
import { OrchestratorFace } from "../../../ui/domain/Face";
import { Icon } from "../../../ui/Icon";
import { IconButton } from "../../../ui/IconButton";
import { ActiveBar } from "../../../ui/layout";
import { Bubble } from "../../../ui/Tip";
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
  loading: boolean;
  selected?: string | undefined;
  older: boolean;
  grouping: Grouping;
  ordering: Ordering;
  onOlder: () => void;
  onOpen: (id: string) => void;
  onAdd: ListAdd;
}) {
  const folded = signal<ReadonlySet<string>>(new Set());
  const nameOf = useNameOf();
  const orchestrators = useOrchestrators();
  const isOrchestrator = (id: string) => orchestrators().some((a) => a.id === id);
  const box = useWidth();
  const wide = () => box.width() === 0 || box.width() >= 640;

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
        <View class="px-3 pb-4">
          <Each of={groupRows(props.cards, props.grouping, rowKeys)} key={(g) => g.key}>
            {(g) => {
              const groupLane = () => g().lane;
              const ordered = () => {
                const l = groupLane();
                return l ? laneOrder(l, g().rows, props.ordering) : orderRows(g().rows, props.ordering, rowKeys);
              };
              const folding = () => groupLane() === "closed" && !props.older && ordered().length > closedShown;
              const rows = () => (folding() ? ordered().slice(0, closedShown) : ordered());
              const hidden = () => (folding() ? ordered().length - closedShown : 0);
              const isFolded = () => folded().has(g().key);
              const label = () => {
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
              };
              const icon = (): JSX.Element => {
                const key = g().key;
                const l = groupLane();
                switch (props.grouping) {
                  case "status":
                    return l ? <StatusMark status={laneStatus[l]} size={14} /> : undefined;
                  case "repo":
                    return <Icon name="folder" size={14} tone="muted" />;
                  case "agent":
                    return !key ? (
                      <NoFaceMark size={14} />
                    ) : isOrchestrator(key) ? (
                      <OrchestratorFace size={16} agent={key} />
                    ) : (
                      <AgentFaceOf agent={key} size={16} />
                    );
                  default:
                    return undefined;
                }
              };
              return (
                <View accessibilityLabel={label()} testID="issue-group" class="mb-1.5">
                  {/* A head of words on the page, not a bar: its line under it sets the group off. */}
                  <View class="mt-2 h-8.5 flex-row items-center rounded-t-md border-b border-line bg-page pr-1 transition duration-120 ease-out hover:bg-hover">
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
                          transitionProperty: "transform",
                          transitionDuration: 120,
                        }}
                      >
                        <Icon name="expand" size={10} tone="muted" />
                      </View>
                      <If when={props.grouping !== "none"}>
                        <View class="w-4 shrink-0 items-center justify-center">{icon()}</View>
                      </If>
                      <Text class="truncate text-sm font-semibold text-ink">{label()}</Text>
                      <View class="shrink-0 rounded-full bg-hover px-1.5 py-px">
                        <Text class="text-2xs font-medium text-muted" style={{ fontVariant: ["tabular-nums"] }}>
                          {`${g().rows.length}`}
                        </Text>
                      </View>
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
  const look = () => cardLook(props.card, props.nameOf, issues(), now());
  const repo = () => cardRepo(props.card);
  const shownFlags = () => (props.wide ? look().flags : look().flags.slice(0, 1));
  const hasTrailingMarks = () => Boolean(look().progress) || shownFlags().length > 0;
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
      tooltip={look().detail ? <Bubble text={look().detail} /> : undefined}
      onPress={() => props.onOpen(props.card.id)}
      class={`relative min-h-9.5 flex-row items-center gap-2.5 rounded-md px-2.5 py-1.5 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus ${props.selected ? "bg-selected" : "hover:bg-hover"}`}
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
          <Each of={shownFlags()}>{(f) => <FlagChip text={f().text} tone={f().tone} />}</Each>
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
