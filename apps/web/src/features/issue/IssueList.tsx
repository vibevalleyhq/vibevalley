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

const styles = stylex.create({
  rowSpan: {
    display: {
      default: "none",
      "@container (width>=640px)": "block",
    },
    width: "2.75rem",
    flexShrink: "0",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  rowSpanPrimary: {
    display: null,
  },
  rowSpanSecondary: {
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
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  rowSpan3: {
    width: {
      default: "3.5rem",
      "@container (width>=640px)": "72px",
    },
    flexShrink: "0",
    textAlign: "right",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  issueListIcon: {},
  issueListIconTone: {
    rotate: "90deg",
  },
  rowDiv: {
    display: "flex",
    height: "38px",
    cursor: "pointer",
    alignItems: "center",
    gap: "0.625rem",
    borderRadius: "var(--radius-md)",
    paddingInline: "0.625rem",
  },
  rowDivTone: {
    backgroundColor: "var(--color-selected)",
  },
  rowDivAlt: {
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  issueListDiv: {
    containerType: "inline-size",
    minHeight: "0",
    flex: "1",
    overflowY: "auto",
    paddingInline: "0.75rem",
    paddingBottom: "0.75rem",
  },
  issueGroup: {
    marginBottom: "0.25rem",
  },
  issueListHeader: {
    position: "sticky",
    top: "0",
    zIndex: "10",
    marginTop: "0.5rem",
    display: "flex",
    height: "34px",
    alignItems: "center",
    borderBottomStyle: "solid",
    borderBottomWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    paddingRight: "0.25rem",
  },
  issueListButton: {
    display: "flex",
    height: "100%",
    minWidth: "0",
    flex: "1",
    cursor: "pointer",
    alignItems: "center",
    gap: "0.625rem",
    paddingInline: "0.625rem",
    textAlign: "left",
  },
  issueListSpan: {
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-semibold)",
  },
  issueListSpan2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  rowSpan4: {
    display: "flex",
    width: "0.875rem",
    flexShrink: "0",
    justifyContent: "center",
  },
  rowSpan22: {
    minWidth: "0",
    flex: "1",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  rowSpan32: {
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
      <div {...stylex.attrs(styles.issueListDiv)}>
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
              <section aria-label={label()} data-testid="issue-group" data-key={g().key} {...stylex.attrs(styles.issueGroup)}>
                {/* A head of words on the page, not a bar: its line under it sets the group off. */}
                <header {...stylex.attrs(styles.issueListHeader)}>
                  <button
                    type="button"
                    onClick={() => fold(g().key)}
                    aria-label={isFolded() ? t("web.issue.list.unfold", { group: label() }) : t("web.issue.list.fold", { group: label() })}
                    {...stylex.attrs(styles.issueListButton)}
                  >
                    <Icon
                      name="expand"
                      size={10}
                      styles={[styles.issueListIcon, !isFolded() ? styles.issueListIconTone : styles.issueListIcon]}
                    />
                    {icon()}
                    <span {...stylex.attrs(styles.issueListSpan)}>{label()}</span>
                    <span {...stylex.attrs(styles.issueListSpan2)}>{g().rows.length}</span>
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
      {...stylex.attrs(styles.rowDiv, props.selected ? styles.rowDivTone : styles.rowDivAlt)}
    >
      <span {...stylex.attrs(styles.rowSpan4)}>
        <Show when={look().priority === "urgent" || look().priority === "high" ? look().priority : undefined}>
          {(pr) => <PriorityMark priority={pr()} size={13} />}
        </Show>
      </span>
      <span {...stylex.attrs(styles.rowSpan)}>{look().number}</span>
      <span {...stylex.attrs(styles.rowSpan4)}>
        <Show when={props.groupStatus === undefined || (look().status !== props.groupStatus && !(props.groupStatus === "todo" && look().status === "backlog"))}>
          <StatusMark status={look().status} tone={look().statusTone} size={13} />
        </Show>
      </span>
      <span {...stylex.attrs(styles.rowSpan22)}>{look().title}</span>
      <Show when={look().progress}>{(pg) => <ProgressMark done={pg().done} total={pg().total} />}</Show>
      <For each={look().flags}>
        {(f, i) => (
          <span {...stylex.attrs(i() > 0 ? styles.rowSpanSecondary : styles.rowSpanPrimary)}>
            <FlagChip text={f.text} tone={f.tone} />
          </span>
        )}
      </For>
      <Show when={props.showRepo}>
        <span {...stylex.attrs(styles.rowSpan2)}>{repo()}</span>
      </Show>
      <span {...stylex.attrs(styles.rowSpan32)}>
        <Show when={cardAgent(props.card) || props.card.kind === "orchestrator"}>
          <CardFace card={props.card} size={18} />
        </Show>
      </span>
      <span {...stylex.attrs(styles.rowSpan3)}>{ago(rowKeys(props.card).updatedAt, now())}</span>
    </div>
  );
}
