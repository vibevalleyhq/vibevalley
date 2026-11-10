import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { IssueStatus } from "@vibevalley/protocol";

import { ago } from "#/base/format.ts";
import { useOrchestrators } from "#/infra/agents.ts";
import { OrchestratorFace } from "#/ui/Face.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { IconButton } from "#/ui/IconButton.tsx";

import { EmptyNote, OlderLink } from "./Board";
import { type BoardCard, cardAgent, cardLook, cardRepo, closedShown, laneLabel, laneStatus } from "./cards";
import { type Grouping, groupRows, laneOrder, type Ordering, orderRows, type RowGroup, rowKeys } from "./display";
import { useIssues, useNameOf } from "./history";
import { AgentFaceOf, CardFace, FlagChip, NoFaceMark, PriorityMark, ProgressMark, StatusMark } from "./Marks";
import type { NewIssueAt } from "./NewIssue";

const recipeStyles = stylex.create({
  rowSpan: {
    display: {
      default: "none",
      "@container (width>=640px)": "block",
    },
    width: "calc(var(--spacing) * 11)",
    flexShrink: "0",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  rowSpanVariant1Case1: {
    display: null,
  },
  rowSpanVariant1Case2: {
    display: {
      default: "none",
      "@container (width>=640px)": "inline",
    },
  },
  rowSpan2: {
    display: {
      default: "none",
      "@container (width>=640px)": "block",
    },
    width: "120px",
    flexShrink: "0",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  rowSpan3: {
    width: {
      default: "calc(var(--spacing) * 14)",
      "@container (width>=640px)": "72px",
    },
    flexShrink: "0",
    textAlign: "right",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
});

const variantStyles2 = stylex.create({
  issueListIcon: {},
  issueListIconVariant: {
    rotate: "90deg",
  },
});

const variantStyles = stylex.create({
  rowDiv: {
    display: "flex",
    height: "38px",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2.5)",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 2.5)",
  },
  rowDivVariant: {
    backgroundColor: "var(--color-selected)",
  },
  rowDivVariant2: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
});

const viewStyles = stylex.create({
  issueListDiv: {
    containerType: "inline-size",
    minHeight: "0",
    flex: "1",
    overflowY: "auto",
    paddingInline: "calc(var(--spacing) * 3)",
    paddingBottom: "calc(var(--spacing) * 3)",
  },
  issueGroup: {
    marginBottom: "var(--spacing)",
  },
  issueListHeader: {
    position: "sticky",
    top: "0",
    zIndex: "10",
    marginTop: "calc(var(--spacing) * 2)",
    display: "flex",
    height: "34px",
    alignItems: "center",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    paddingRight: "var(--spacing)",
  },
  issueListButton: {
    display: "flex",
    height: "100%",
    minWidth: "0",
    flex: "1",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2.5)",
    paddingInline: "calc(var(--spacing) * 2.5)",
    textAlign: "left",
  },
  issueListSpan: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  issueListSpan2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  rowSpan: {
    display: "flex",
    width: "calc(var(--spacing) * 3.5)",
    flexShrink: "0",
    justifyContent: "center",
  },
  rowSpan2: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  rowSpan3: {
    display: "flex",
    width: "18px",
    flexShrink: "0",
    justifyContent: "center",
  },
});

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
      <div {...stylex.attrs(viewStyles.issueListDiv)}>
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
              <section aria-label={label()} data-testid="issue-group" data-key={g().key} {...stylex.attrs(viewStyles.issueGroup)}>
                {/* A head of words on the page, not a bar: its line under it sets the group off. */}
                <header {...stylex.attrs(viewStyles.issueListHeader)}>
                  <button
                    type="button"
                    onClick={() => fold(g().key)}
                    aria-label={isFolded() ? t("web.issue.list.unfold", { group: label() }) : t("web.issue.list.fold", { group: label() })}
                    {...stylex.attrs(viewStyles.issueListButton)}
                  >
                    <Icon
                      name="expand"
                      size={10}
                      styles={[variantStyles2.issueListIcon, !isFolded() ? variantStyles2.issueListIconVariant : variantStyles2.issueListIcon]}
                    />
                    {icon()}
                    <span {...stylex.attrs(viewStyles.issueListSpan)}>{label()}</span>
                    <span {...stylex.attrs(viewStyles.issueListSpan2)}>{g().rows.length}</span>
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
      {...stylex.attrs(variantStyles.rowDiv, props.selected ? variantStyles.rowDivVariant : variantStyles.rowDivVariant2)}
    >
      <span {...stylex.attrs(viewStyles.rowSpan)}>
        <Show when={look().priority === "urgent" || look().priority === "high" ? look().priority : undefined}>
          {(pr) => <PriorityMark priority={pr()} size={13} />}
        </Show>
      </span>
      <span {...stylex.attrs(recipeStyles.rowSpan)}>{look().number}</span>
      <span {...stylex.attrs(viewStyles.rowSpan)}>
        <Show when={props.groupStatus === undefined || (look().status !== props.groupStatus && !(props.groupStatus === "todo" && look().status === "backlog"))}>
          <StatusMark status={look().status} tone={look().statusTone} size={13} />
        </Show>
      </span>
      <span {...stylex.attrs(viewStyles.rowSpan2)}>{look().title}</span>
      <Show when={look().progress}>{(pg) => <ProgressMark done={pg().done} total={pg().total} />}</Show>
      <For each={look().flags}>
        {(f, i) => (
          <span {...stylex.attrs(i() > 0 ? recipeStyles.rowSpanVariant1Case2 : recipeStyles.rowSpanVariant1Case1)}>
            <FlagChip text={f.text} tone={f.tone} />
          </span>
        )}
      </For>
      <Show when={props.showRepo}>
        <span {...stylex.attrs(recipeStyles.rowSpan2)}>{repo()}</span>
      </Show>
      <span {...stylex.attrs(viewStyles.rowSpan3)}>
        <Show when={cardAgent(props.card) || props.card.kind === "orchestrator"}>
          <CardFace card={props.card} size={18} />
        </Show>
      </span>
      <span {...stylex.attrs(recipeStyles.rowSpan3)}>{ago(rowKeys(props.card).updatedAt, now())}</span>
    </div>
  );
}
