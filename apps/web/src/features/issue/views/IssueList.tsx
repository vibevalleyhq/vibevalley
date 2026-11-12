import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { IssueStatus } from "@vibevalley/protocol";

import { ago } from "#/base/format.ts";
import { type BoardCard, cardAgent, cardLook, cardRepo, closedShown, laneLabel, laneStatus } from "#/features/issue/model/cards.ts";
import { type Grouping, groupRows, laneOrder, type Ordering, orderRows, type RowGroup, rowKeys } from "#/features/issue/model/display.ts";
import { useIssues, useNameOf } from "#/features/issue/model/history.ts";
import { useOrchestrators } from "#/infra/agents.ts";
import { OrchestratorFace } from "#/ui/domain/Face.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { IconButton } from "#/ui/IconButton.tsx";

import { EmptyNote, OlderLink } from "./Board";
import { AgentFaceOf, CardFace, FlagChip, NoFaceMark, PriorityMark, ProgressMark, StatusMark } from "./Marks";
import type { NewIssueAt } from "./NewIssue";

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
  const [folded, setFolded] = createSignal<ReadonlySet<string>>(new Set());
  const nameOf = useNameOf();
  const orchestrators = useOrchestrators();
  const isOrchestrator = (id: string) => orchestrators().some((a) => a.id === id);

  // Only where a new todo belongs: the todo group, a repo's, a helper's (not the orchestrator's), or the one group.
  const canAdd = (g: RowGroup<BoardCard>) => (props.grouping === "status" ? g.lane === "todo" : props.grouping === "agent" ? !isOrchestrator(g.key) : true);
  const add = (g: RowGroup<BoardCard>) => props.onAdd(props.grouping === "repo" ? { repo: g.key } : props.grouping === "agent" ? { agent: g.key } : {});
  const fold = (key: string) =>
    setFolded((f) => {
      const n = new Set(f);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  return (
    <Show when={!props.loading} fallback={<EmptyNote>{t("web.issue.reading")}</EmptyNote>}>
      <div class="@container min-h-0 flex-1 overflow-y-auto px-3 pb-3">
        <For each={groupRows(props.cards, props.grouping, rowKeys)} keyed={(g) => g.key}>
          {(g) => {
            const groupLane = () => g().lane;
            const folding = () => groupLane() === "closed" && !props.older && ordered().length > closedShown;
            const ordered = () => {
              const l = groupLane();
              return l ? laneOrder(l, g().rows, props.ordering) : orderRows(g().rows, props.ordering, rowKeys);
            };
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
                  return l ? <StatusMark status={laneStatus[l]} /> : undefined;
                case "repo":
                  return <Icon name="folder" size={14} />;
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
              <section aria-label={label()} data-testid="issue-group" data-key={g().key} class="mb-1">
                {/* A head of words on the page, not a bar: its line under it sets the group off. */}
                <header class="sticky top-0 z-10 mt-2 flex h-8.5 items-center border-b border-line bg-page pr-1">
                  <button
                    type="button"
                    onClick={() => fold(g().key)}
                    aria-label={isFolded() ? t("web.issue.list.unfold", { group: label() }) : t("web.issue.list.fold", { group: label() })}
                    class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2.5 text-left"
                  >
                    <Icon name="expand" size={10} class={["", !isFolded() ? "[rotate:90deg]" : ""]} />
                    {icon()}
                    <span class="truncate text-sm font-semibold">{label()}</span>
                    <span class="text-xs text-muted">{g().rows.length}</span>
                  </button>
                  <Show when={canAdd(g())}>
                    <IconButton icon="add" label={t("web.issue.list.writeIn", { group: label() })} onClick={() => add(g())} />
                  </Show>
                </header>
                <Show when={!isFolded()}>
                  <For each={rows()} keyed={(c) => c.id}>
                    {(c) => {
                      const l = groupLane();
                      return (
                        <Row
                          card={c()}
                          selected={c().id === props.selected}
                          showRepo={props.grouping !== "repo"}
                          groupStatus={props.grouping === "status" && l ? laneStatus[l] : undefined}
                          onOpen={props.onOpen}
                          nameOf={nameOf()}
                        />
                      );
                    }}
                  </For>
                  <Show when={hidden() > 0 || (groupLane() === "closed" && props.older && g().rows.length > closedShown)}>
                    <OlderLink hidden={hidden()} onClick={props.onOlder} />
                  </Show>
                </Show>
              </section>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

function Row(props: {
  card: BoardCard;
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
  return (
    <div
      role="button"
      tabindex={0}
      data-testid="issue-card"
      data-key={props.card.id}
      data-kind={props.card.kind}
      aria-label={look().title}
      aria-current={props.selected ? "true" : undefined}
      title={look().detail}
      onClick={() => props.onOpen(props.card.id)}
      onKeyDown={(e) => {
        if (e.key === "Enter") props.onOpen(props.card.id);
      }}
      class={["flex h-9.5 cursor-pointer items-center gap-2.5 rounded-md px-2.5", props.selected ? "bg-selected" : "hover:bg-hover"]}
    >
      <span class="flex w-3.5 shrink-0 justify-center">
        <Show when={look().priority === "urgent" || look().priority === "high" ? look().priority : undefined}>
          {(pr) => <PriorityMark priority={pr()} size={13} />}
        </Show>
      </span>
      <span class="hidden @min-[640px]:block w-11 shrink-0 truncate text-xs text-muted">{look().number}</span>
      <span class="flex w-3.5 shrink-0 justify-center">
        <Show when={props.groupStatus === undefined || (look().status !== props.groupStatus && !(props.groupStatus === "todo" && look().status === "backlog"))}>
          <StatusMark status={look().status} tone={look().statusTone} size={13} />
        </Show>
      </span>
      <span class="min-w-0 flex-1 truncate text-sm">{look().title}</span>
      <Show when={look().progress}>{(pg) => <ProgressMark done={pg().done} total={pg().total} />}</Show>
      <For each={look().flags}>
        {(f, i) => (
          <span class={i() > 0 ? "hidden @min-[640px]:inline" : ""}>
            <FlagChip text={f.text} tone={f.tone} />
          </span>
        )}
      </For>
      <Show when={props.showRepo}>
        <span class="hidden @min-[640px]:block w-30 shrink-0 truncate text-xs text-muted">{repo()}</span>
      </Show>
      <span class="flex w-4.5 shrink-0 justify-center">
        <Show when={cardAgent(props.card) || props.card.kind === "orchestrator"}>
          <CardFace card={props.card} size={18} />
        </Show>
      </span>
      <span class="w-14 @min-[640px]:w-18 shrink-0 text-right text-xs text-muted">{ago(rowKeys(props.card).updatedAt, now())}</span>
    </div>
  );
}
