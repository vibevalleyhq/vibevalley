import type { JSX } from "@solidjs/web";
import { createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { IssueStatus } from "@vibevalley/protocol";

import { ago } from "@/base/format";
import { useOrchestrators } from "@/infra/agents";
import { OrchestratorFace } from "@/ui/Face";
import { Icon } from "@/ui/Icon";
import { IconButton } from "@/ui/IconButton";

import { EmptyNote, OlderLink, QuickAdd } from "./Board";
import { type BoardCard, cardAgent, cardLook, cardProject, laneOrder, rowFacts } from "./cards";
import { type Grouping, groupRows, type Ordering, orderRows, type RowGroup } from "./display";
import { closedShown, laneLabel, laneStatus } from "./lanes";
import { AgentFaceOf, CardFace, FlagChip, NoFaceMark, PriorityMark, ProgressMark, StatusMark } from "./Marks";
import { useGraphs, useNameOf } from "./queries";

/** The quick add, with the group's project or helper when grouped by one. */
export type ListAdd = (text: string, where: { project?: string; agent?: string }) => void;

/** The issues as rows, grouped as the owner picked: Linear's list. A row opens the issue as a card does. */
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
  const [adding, setAdding] = createSignal<string>();
  const nameOf = useNameOf();
  const orchestrators = useOrchestrators();
  const isOrchestrator = (id: string) => orchestrators().some((a) => a.id === id);

  // Only where a new 待办 belongs: the 待办 group, a project's, a helper's (not the orchestrator's), or the one group.
  const canAdd = (g: RowGroup<BoardCard>) => (props.grouping === "status" ? g.lane === "todo" : props.grouping === "agent" ? !isOrchestrator(g.key) : true);
  const add = (g: RowGroup<BoardCard>, text: string) => {
    setAdding(undefined);
    props.onAdd(text, props.grouping === "project" ? { project: g.key } : props.grouping === "agent" ? { agent: g.key } : {});
  };
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
        <For each={groupRows(props.cards, props.grouping, rowFacts)} keyed={(g) => g.key}>
          {(g) => {
            const folding = () => g().lane === "closed" && !props.older && ordered().length > closedShown;
            const ordered = () => (g().lane ? laneOrder(g().lane!, g().rows, props.ordering) : orderRows(g().rows, props.ordering, rowFacts));
            const rows = () => (folding() ? ordered().slice(0, closedShown) : ordered());
            const hidden = () => (folding() ? ordered().length - closedShown : 0);
            const isFolded = () => folded().has(g().key);
            const label = () =>
              props.grouping === "status"
                ? laneLabel[g().lane!]
                : props.grouping === "project"
                  ? g().key || t("web.issue.list.noProject")
                  : props.grouping === "agent"
                    ? g().key
                      ? nameOf()(g().key)
                      : t("web.issue.noHelper")
                    : t("web.issue.list.all");
            const icon = (): JSX.Element => {
              const key = g().key;
              switch (props.grouping) {
                case "status":
                  return <StatusMark status={laneStatus[g().lane!]} />;
                case "project":
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
                <header class="sticky top-0 z-10 mt-2 flex h-[34px] items-center border-b border-line bg-page pr-1">
                  <button
                    type="button"
                    onClick={() => fold(g().key)}
                    aria-label={isFolded() ? t("web.issue.list.unfold", { group: label() }) : t("web.issue.list.fold", { group: label() })}
                    class="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2.5 px-2.5 text-left"
                  >
                    <Icon name="expand" size={10} class={{ "rotate-90": !isFolded() }} />
                    {icon()}
                    <span class="truncate text-sm font-semibold">{label()}</span>
                    <span class="text-xs text-muted">{g().rows.length}</span>
                  </button>
                  <Show when={canAdd(g())}>
                    <IconButton
                      icon="add"
                      label={t("web.issue.list.writeIn", { group: label() })}
                      onClick={() => setAdding(adding() === g().key ? undefined : g().key)}
                    />
                  </Show>
                </header>
                <Show when={!isFolded()}>
                  <Show when={adding() === g().key}>
                    <div class="px-3 py-1.5">
                      <QuickAdd autofocus onAdd={(t) => add(g(), t)} />
                    </div>
                  </Show>
                  <For each={rows()} keyed={(c) => c.id}>
                    {(c) => (
                      <Row
                        card={c()}
                        selected={c().id === props.selected}
                        showProject={props.grouping !== "project"}
                        groupStatus={props.grouping === "status" ? laneStatus[g().lane!] : undefined}
                        onOpen={props.onOpen}
                        nameOf={nameOf()}
                      />
                    )}
                  </For>
                  <Show when={hidden() > 0 || (g().lane === "closed" && props.older && g().rows.length > closedShown)}>
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
  showProject: boolean;
  /** The status the group stands for, when grouped by it: a row says its own only when it differs. */
  groupStatus?: IssueStatus | undefined;
  onOpen: (id: string) => void;
  nameOf: (id: string) => string;
}) {
  const graphs = useGraphs();
  const now = () => Date.now();
  const look = () => cardLook(props.card, props.nameOf, graphs(), now());
  const project = () => cardProject(props.card);
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
      class={["flex h-[38px] cursor-pointer items-center gap-2.5 rounded-md px-2.5", props.selected ? "bg-selected" : "hover:bg-hover"]}
    >
      <span class="flex w-3.5 shrink-0 justify-center">
        <Show when={look().priority === "urgent" || look().priority === "high" ? look().priority : undefined}>
          {(pr) => <PriorityMark priority={pr()} size={13} />}
        </Show>
      </span>
      <span class="hidden w-11 shrink-0 truncate text-xs text-muted @min-[640px]:block">{look().number}</span>
      <span class="flex w-3.5 shrink-0 justify-center">
        <Show when={props.groupStatus === undefined || (look().status !== props.groupStatus && !(props.groupStatus === "todo" && look().status === "backlog"))}>
          <StatusMark status={look().status} tone={look().statusTone} size={13} />
        </Show>
      </span>
      <span class="min-w-0 flex-1 truncate text-sm">{look().title}</span>
      <Show when={look().progress}>{(pg) => <ProgressMark done={pg().done} total={pg().total} />}</Show>
      <For each={look().flags}>
        {(f, i) => (
          <span class={{ "hidden @min-[640px]:inline": i() > 0 }}>
            <FlagChip text={f.text} tone={f.tone} />
          </span>
        )}
      </For>
      <Show when={props.showProject}>
        <span class="hidden w-[120px] shrink-0 truncate text-xs text-muted @min-[640px]:block">{project()}</span>
      </Show>
      <span class="flex w-[18px] shrink-0 justify-center">
        <Show when={cardAgent(props.card) || props.card.kind === "orchestrator"}>
          <CardFace card={props.card} size={18} />
        </Show>
      </span>
      <span class="w-14 shrink-0 text-right text-xs text-muted @min-[640px]:w-[72px]">{ago(rowFacts(props.card).updatedAt, now())}</span>
    </div>
  );
}
