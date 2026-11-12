import * as stylex from "@stylexjs/stylex";
import { Array as Arr, String as Str } from "effect";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";

import { list, t } from "@vibevalley/i18n";
import { DeliverableValues, type Issue, type IssueAct, PriorityValues, type Session, type SessionView } from "@vibevalley/protocol";
import { closedText, plainText } from "@vibevalley/protocol/rules";

import { useNow } from "#/base/dom.tsx";
import { wallClockText } from "#/base/format.ts";
import { IssueArtifacts } from "#/features/artifact/index.ts";
import { createIssueActs } from "#/features/issue/model/acts.ts";
import { changesLine } from "#/features/issue/model/changes.ts";
import { useIssueChanges, useIssues, useIssueTimeline } from "#/features/issue/model/history.ts";
import { issueMove, movedIssue } from "#/features/issue/model/moves.ts";
import { issueState, noStepsText, stageTone } from "#/features/issue/model/overview.ts";
import { issueSet, labeledIssue, sendLabel } from "#/features/issue/model/write.ts";
import { createSessionEvents } from "#/features/session/index.ts";
import { useAgent } from "#/infra/agents.ts";
import { ready } from "#/infra/query.ts";
import { useIntents } from "#/state/intent.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { TextArea, TextInput } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { Markdown } from "#/ui/Markdown.tsx";
import { Dot } from "#/ui/Tag.tsx";
import { toast } from "#/ui/toasts.ts";

import { ActLines } from "./ActLines";
import { ChangesBody, ChangesHead } from "./CloseDialog";
import { AnswerView, Criteria, OrchestratorIssueDetail, Question, Runs, stepsLine, Story, WorkLog } from "./IssueSections";
import { IssueThread } from "./IssueThread";
import { Fold, IssueSheet, More, Note, Pick, Property, SheetLabel } from "./Sheet";

const styles = stylex.create({
  issueDetailSpan: {
    minWidth: "0",
    flex: "1",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    wordBreak: "break-all",
    WebkitUserSelect: "text",
    userSelect: "text",
  },
  issueDetailMarkdown: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-ink)",
  },
  issueDetailTextArea: {
    marginTop: "0.625rem",
  },
  titleButton: {
    cursor: "text",
    borderRadius: "var(--radius-sm)",
    marginInline: "-0.25rem",
    paddingInline: "0.25rem",
    textAlign: "start",
    font: "inherit",
    color: "inherit",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  titleInput: {
    minWidth: "0",
    flex: "1",
    fontSize: "var(--text-lg)",
    lineHeight: "var(--leading-lg)",
    fontWeight: "var(--font-weight-semibold)",
  },
  titlePending: {
    opacity: "0.7",
  },
  issueDetailH1: {
    WebkitLineClamp: "2",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    minWidth: "0",
    flex: "1",
    fontSize: "var(--text-lg)",
    lineHeight: "var(--leading-lg)",
    fontWeight: "var(--font-weight-semibold)",
  },
  issueDetailSpanTone: {
    color: "var(--color-berry)",
  },
  issueDetailSpanAlt: {
    color: {
      default: "var(--color-ink)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-ink) 80%, transparent)",
    },
  },
  issueDetailDiv: {
    marginTop: "0.25rem",
    WebkitLineClamp: "4",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
  },
  issueDetailDiv2: {
    paddingRight: "2.5rem",
  },
  trail: {
    marginBottom: "0.375rem",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  parentIssue: {
    cursor: "pointer",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-water)",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  issueDetailDiv22: {
    containerType: "inline-size",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: "0.5rem",
  },
  issueDetailSpan4: {
    flexShrink: "0",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  issueNow: {
    marginTop: "0.375rem",
    display: "flex",
    // Top-aligned, so a line that wraps on a narrow screen keeps the dot on its first line.
    alignItems: "flex-start",
    gap: "0.5rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  issueNowDot: {
    flexShrink: 0,
    // Centres the 8px dot on the first line: (line height - dot) / 2.
    marginTop: "calc((var(--leading-sm) - 8px) / 2)",
  },
  issueNowLine: {
    minWidth: 0,
  },
  issueNowPart: {
    whiteSpace: "nowrap",
  },
  issueAsk: {
    marginBottom: "1.25rem",
  },
  issueDetailDiv3: {
    fontWeight: "var(--font-weight-semibold)",
  },
  issueDetailDiv4: {
    marginTop: "0.625rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.5rem",
  },
  issueDetailDiv5: {
    marginTop: "0.5rem",
    display: "flex",
    gap: "0.5rem",
  },
  issueDetailSpan22: {
    marginLeft: "0.5rem",
    fontWeight: "var(--font-weight-normal)",
  },
  issueDetailDiv6: {
    marginBottom: "0.375rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-water)",
  },
  issueDetailDiv7: {
    marginBottom: "0.375rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  issueDetailP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-muted)",
  },
  issueDetailDiv8: {
    marginTop: "0.5rem",
  },
  issueDetailDiv9: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  issueDetailDiv10: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-berry)",
  },
  issueDetailDiv11: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  issueDetailDiv12: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  issueDetailA: {
    marginTop: "0.25rem",
    display: "block",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-water)",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  issueDetailP2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-faint)",
  },
  issueDetailDiv13: {
    marginTop: "0.75rem",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-line)",
  },
  issueDetailSummary: {
    cursor: "pointer",
    paddingBlock: "0.625rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-semibold)",
  },
  issueDetailSpan32: {
    marginLeft: "0.5rem",
    fontWeight: "var(--font-weight-normal)",
    color: "var(--color-muted)",
  },
  issueDetailDiv14: {
    marginBlock: "0.75rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.5rem",
  },
  issueDetailSpan42: {
    color: "var(--color-accent)",
  },
  issueDetailSpan5: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  issueDetailSpan6: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.25rem",
  },
  issueDetailButton: {
    cursor: "pointer",
    borderRadius: "var(--radius-sm)",
    padding: "0.125rem",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  issueDetailDiv15: {
    color: "var(--color-faint)",
    textDecorationLine: "line-through",
  },
});

export { AnswerView, OrchestratorIssueDetail };

/** The workbench's issue page, answering the user top to bottom. the side holds the facts. */
export function IssueDetail(props: {
  issue: Issue;
  sessions: Session[];
  session?: SessionView | undefined;
  onClose: (session: Session, review: boolean) => void;
  onParent?: (() => void) | undefined;
}) {
  const issues = useIssues();
  const now = useNow();
  const moves = useIntents(issueMove);
  const sets = useIntents(issueSet);
  const labeled = () => labeledIssue(issues().find((item) => item.id === props.issue.id) ?? props.issue, sets.list());
  const live = () => labeled().issue;
  const s = createMemo(() => issueState(movedIssue(live(), moves.list()), props.sessions, props.session, issues()));
  const head = () => s().head;
  // The box under the block holds an answer, the findings of reject, a word to the helper, or what a reopen asks for.
  const acts = createIssueActs(() => props.issue, {
    act: createAct(),
    complete: () => props.onClose(props.session ?? head(), true),
    close: () => props.onClose(props.session ?? head(), false),
    told: (title, description) => toast(t("shared.join.labeled", { label: title, text: description })),
  });
  const { busy, text, setText, box, setBox, go } = acts;
  const setLabel = (label: Omit<Parameters<typeof sendLabel>[1], "id">) => void sendLabel(sets, { id: props.issue.id, ...label });
  const doAct = acts.send;
  const sayAct = acts.say;
  const agent = useAgent(() => head().agent);
  const [showSteps, setShowSteps] = createSignal(false);
  const steps = createSessionEvents(() => head().id, showSteps);
  const changesQuery = useIssueChanges(
    () => props.issue.id,
    () => s().showsChanges,
  );
  const changes = () => ready(changesQuery, undefined);
  const timelineQuery = useIssueTimeline(
    () => props.issue,
    () => head().runs,
  );
  const timeline = () => ready(timelineQuery, undefined);

  /** lead is read as it renders: the lead changes as the issue moves on. */
  const button = (a: IssueAct, lead: () => boolean) => (
    <Button data-act={a} tone={lead() ? "primary" : acts.rejecting(a) ? "danger" : "plain"} disabled={acts.disabled(a)} onClick={() => go(a)}>
      {acts.label(a)}
    </Button>
  );

  const parent = () => issues().find((item) => item.id === props.issue.parent);
  const tone = () => stageTone[s().stage.state];
  const heading = (
    <div {...stylex.attrs(styles.issueDetailDiv2)}>
      <nav aria-label={t("web.issue.detail.trail")} data-testid="issue-trail" {...stylex.attrs(styles.trail)}>
        <span>{s().repo || t("web.issue.detail.noRepo")}</span>
        <Show when={s().inFamily ? props.onParent : undefined}>
          {(onParent) => (
            <>
              <Icon name="next" size={12} />
              <button type="button" data-testid="parent-issue" onClick={() => onParent()()} {...stylex.attrs(styles.parentIssue)}>
                {parent()?.title ?? t("web.issue.family.parent")}
              </button>
            </>
          )}
        </Show>
        <Icon name="next" size={12} />
        <span {...stylex.attrs(styles.issueDetailSpan4)}>#{props.issue.number}</span>
      </nav>
      <div {...stylex.attrs(styles.issueDetailDiv22)}>
        <IssueTitle shown={s().title} full={live().title} editable={s().open} state={labeled().state("title")} onSave={(title) => setLabel({ title })} />
      </div>
      <div {...stylex.attrs(styles.issueNow)} aria-label={t("web.issue.detail.now")} data-testid="issue-now" data-state={s().stage.state}>
        <Dot tone={tone()} size={8} ring={false} styles={styles.issueNowDot} />
        <span {...stylex.attrs(styles.issueNowLine, tone() === "berry" ? styles.issueDetailSpanTone : styles.issueDetailSpanAlt)}>
          {/* Each part whole: a narrow screen wraps between them, not inside "第 1 轮". */}
          <For each={s().statusParts(now(), timeline()?.spent?.cny)}>
            {(part, i) => (
              <>
                {i() > 0 ? " · " : ""}
                <span {...stylex.attrs(styles.issueNowPart)}>{part}</span>
              </>
            )}
          </For>
        </span>
      </div>
    </div>
  );

  const main = (
    <>
      <Show when={s().description}>
        <section data-testid="issue-requirement">
          <SheetLabel>{t("web.issue.detail.full")}</SheetLabel>
          <Markdown styles={styles.issueDetailMarkdown} text={s().description} />
        </section>
      </Show>
      <ActLines issue={props.issue.id} words={acts.words()} onSayAgain={acts.sayAgain} onTakeBack={acts.takeBack} />
      <Show when={s().ask}>
        {(ask) => (
          <section aria-label={t("web.issue.detail.yours")} data-testid="issue-ask" {...stylex.attrs(styles.issueAsk)}>
            <SheetLabel>{t("web.issue.detail.yours")}</SheetLabel>
            <Note tone={ask().tone}>
              <div {...stylex.attrs(styles.issueDetailDiv3)}>{ask().head}</div>
              <Show when={ask().line}>{(line) => <div {...stylex.attrs(styles.issueDetailDiv)}>{plainText(line())}</div>}</Show>
              <Show when={s().stage.state === "asking"}>
                <For each={props.issue.questions}>
                  {(a) => <Question ask={a} busy={busy()} onPick={(o) => void doAct("answer", o).then((ok) => ok && setText(""))} />}
                </For>
              </Show>
            </Note>
            <Show when={s().stage.state === "asking" || s().stage.state === "canceled" || box()}>
              <TextArea
                data-testid="issue-words"
                data-box={box()}
                styles={styles.issueDetailTextArea}
                rows={box() === "reject" ? 3 : 2}
                value={text()}
                disabled={busy()}
                onInput={(e) => setText(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && box() !== "reject" && s().stage.state !== "canceled") {
                    e.preventDefault();
                    sayAct(box() === "tell" ? "tell" : "answer");
                  }
                }}
                placeholder={
                  box() === "reject"
                    ? t("web.issue.detail.rejectWhere")
                    : s().stage.state === "asking"
                      ? t("web.issue.detail.sayIt")
                      : s().stage.state === "canceled"
                        ? t("web.issue.reopen.what")
                        : t("web.issue.detail.tell", { who: head().name })
                }
                aria-label={
                  box() === "reject"
                    ? t("web.issue.detail.rejectLabel")
                    : s().stage.state === "asking"
                      ? t("web.issue.detail.answer")
                      : s().stage.state === "canceled"
                        ? t("web.issue.reopen.title")
                        : t("web.issue.detail.tell", { who: head().name })
                }
              />
            </Show>
            <div {...stylex.attrs(styles.issueDetailDiv4)}>
              <Show when={s().lead} keyed>
                {(lead) => button(lead, () => true)}
              </Show>
              <For each={s().others.filter((a) => a !== "close" && a !== "stop")}>{(a) => button(a, () => false)}</For>
            </div>
          </section>
        )}
      </Show>
      <Show when={!s().ask && box() === "tell"}>
        <section aria-label={t("web.issue.detail.tellSection")} {...stylex.attrs(styles.issueAsk)}>
          <TextArea
            rows={2}
            value={text()}
            disabled={busy()}
            onInput={(e) => setText(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                e.preventDefault();
                sayAct("tell");
              }
            }}
            placeholder={head().phase._tag === "working" ? t("web.issue.detail.tellWorking") : t("web.issue.detail.tellIdle")}
            aria-label={t("web.issue.detail.tell", { who: head().name })}
            autofocus
          />
          <div {...stylex.attrs(styles.issueDetailDiv5)}>
            {button("tell", () => true)}
            <Button disabled={busy()} onClick={() => setBox(undefined)}>
              {t("web.issue.never")}
            </Button>
          </div>
        </section>
      </Show>

      <section aria-label={t("web.issue.detail.progress")} data-testid="issue-progress" data-met={s().met} data-total={s().criteria.length}>
        <SheetLabel>
          {t("web.issue.detail.progress")}
          <Show when={s().criteria.length > 0}>
            <span {...stylex.attrs(styles.issueDetailSpan22)}>{t("web.issue.detail.met", { met: s().met, of: s().criteria.length })}</span>
          </Show>
        </SheetLabel>
        <Show when={s().doing}>
          <div {...stylex.attrs(styles.issueDetailDiv6)}>{s().doing}</div>
        </Show>
        <Show when={s().inFamily}>
          <div {...stylex.attrs(styles.issueDetailDiv7)}>{s().parentText}</div>
        </Show>
        <Show
          when={s().criteria.length > 0}
          fallback={<p {...stylex.attrs(styles.issueDetailP)}>{t("web.issue.detail.noCriteria", { answer: live().deliver === "answer" })}</p>}
        >
          <Criteria rows={s().criteria} checking={s().stage.state === "reviewing" && props.issue.reviewedAt === undefined} />
        </Show>
        <Show when={s().openFindings.length > 0}>
          <div {...stylex.attrs(styles.issueDetailDiv8)}>
            <div {...stylex.attrs(styles.issueDetailDiv9)}>{t("web.issue.detail.rejected")}</div>
            <For each={s().openFindings}>{(f) => <div {...stylex.attrs(styles.issueDetailDiv10)}>· {f.text}</div>}</For>
          </div>
        </Show>
      </section>

      <section aria-label={t("web.issue.detail.made")} data-testid="issue-made">
        <SheetLabel>{t("web.issue.detail.made")}</SheetLabel>
        <Switch
          fallback={
            <p {...stylex.attrs(styles.issueDetailP)}>
              {s().stage.state === "done" ? t("shared.join.sentence", { text: closedText(props.issue) }) : t("web.issue.detail.nothingToSee")}
            </p>
          }
        >
          <Match when={live().deliver === "answer"}>
            <Show when={props.issue.answer} fallback={<p {...stylex.attrs(styles.issueDetailP)}>{t("web.issue.detail.noAnswer")}</p>}>
              {(a) => <AnswerView answer={a()} />}
            </Show>
          </Match>
          <Match when={s().showsChanges && changes()}>
            {(c) => (
              <Show
                when={c().commits.length > 0 || c().uncommitted.length > 0 || c().files.length > 0}
                fallback={<p {...stylex.attrs(styles.issueDetailP)}>{t("web.issue.detail.noChanges")}</p>}
              >
                <div {...stylex.attrs(styles.issueDetailDiv11)}>
                  <div {...stylex.attrs(styles.issueDetailDiv12)}>{changesLine(c())}</div>
                  <Show when={c().conflicts.length > 0}>
                    <div {...stylex.attrs(styles.issueDetailDiv10)}>{t("web.issue.detail.conflict", { base: c().base, files: list(c().conflicts) })}</div>
                  </Show>
                  <Fold label={t("web.issue.detail.changedFiles")} summary={t("web.issue.detail.fileCount", { n: c().files.length })}>
                    <ChangesHead changes={c()} />
                    <ChangesBody changes={c()} />
                  </Fold>
                </div>
              </Show>
            )}
          </Match>
          <Match when={s().showsChanges}>
            <p {...stylex.attrs(styles.issueDetailP)}>{changesQuery.status() === "pending" ? t("web.issue.reading") : t("web.issue.detail.changesUnread")}</p>
          </Match>
        </Switch>
        <Show when={props.issue.pullRequest}>
          {(pr) => (
            <a href={pr().url} target="_blank" rel="noreferrer" {...stylex.attrs(styles.issueDetailA)}>
              {t("shared.join.aside", { text: `PR #${pr().number}`, aside: pr().state })}
            </a>
          )}
        </Show>
      </section>

      <IssueThread issue={props.issue.id} />
      <IssueArtifacts issue={props.issue.id} heading={<SheetLabel>{t("web.artifact.issue.title")}</SheetLabel>} />

      <section aria-label={t("web.issue.detail.story")} data-testid="issue-story">
        <SheetLabel>{t("web.issue.detail.story")}</SheetLabel>
        <Show
          when={timeline()}
          fallback={
            <p {...stylex.attrs(styles.issueDetailP2)}>{timelineQuery.status() === "pending" ? t("web.issue.reading") : t("web.issue.detail.unread")}</p>
          }
        >
          {(line) => <Story milestones={line().milestones} />}
        </Show>
        <div {...stylex.attrs(styles.issueDetailDiv13)}>
          <details onToggle={(event) => setShowSteps(event.currentTarget.open)}>
            <summary {...stylex.attrs(styles.issueDetailSummary)}>
              {t("web.issue.detail.steps")}
              <Show when={steps().length > 0}>
                <span {...stylex.attrs(styles.issueDetailSpan32)}>{stepsLine(steps())}</span>
              </Show>
            </summary>
            <Show when={showSteps()}>
              <Show when={steps().length > 0 ? steps() : undefined} fallback={<p {...stylex.attrs(styles.issueDetailP2)}>{noStepsText(head())}</p>}>
                {(st) => <WorkLog steps={st()} />}
              </Show>
            </Show>
          </details>
          <Fold label={t("web.issue.detail.runs")} summary={s().historyLine}>
            <Runs issue={props.issue.id} version={`${props.issue.stage.state}:${props.session?.runs}:${props.session?.phase._tag}`} />
          </Fold>
        </div>
      </section>
    </>
  );

  // The acts the block above does not offer: a word, a stop, a close.
  const sideActs = () => {
    const all = s().stage.acts.map((a) => a.act);
    return s().ask ? all.filter((a) => a === "close" || a === "stop") : all;
  };
  // Each status the issue can move to is one of its acts: picking it runs that act, with its dialog or its box.
  const statusMoves = () => Arr.flatMap(s().stage.acts, (a) => (a.does === "move" ? [{ act: a.act, status: a.status }] : []));
  // Two acts to one status (reject and resume both go back to work) say which act each is.
  const statusOptions = () => {
    const moves = statusMoves();
    const options: { value: IssueAct | "now"; label: string }[] = [{ value: "now", label: t(`shared.status.${live().status}`) }];
    for (const m of moves) {
      const status = t(`shared.status.${m.status}`);
      const shared = Arr.countBy(moves, (o) => o.status === m.status) > 1;
      options.push({ value: m.act, label: shared ? t("shared.join.aside", { text: status, aside: acts.label(m.act) }) : status });
    }
    return options;
  };
  const side = (
    <>
      <SheetLabel>{t("web.issue.detail.properties")}</SheetLabel>
      <Property label={t("web.issue.detail.status")}>
        <Pick<IssueAct | "now">
          label={t("web.issue.detail.status")}
          testid="issue-status"
          value="now"
          state={acts.moving()}
          disabled={busy() || statusMoves().length === 0}
          onChange={(a) => a !== "now" && go(a)}
          options={statusOptions()}
        />
      </Property>
      <Property label={t("web.issue.detail.priority")}>
        <Pick
          label={t("web.issue.detail.priority")}
          testid="issue-priority"
          value={live().priority}
          state={labeled().state("priority")}
          disabled={!s().open}
          onChange={(priority) => setLabel({ priority })}
          options={Arr.map(PriorityValues, (v) => ({ value: v, label: t(`shared.priority.${v}`) }))}
        />
      </Property>
      <Show when={!s().inFamily}>
        <Property label={t("web.issue.detail.deliver")}>
          <Pick
            label={t("web.issue.detail.deliver")}
            testid="issue-deliver"
            value={live().deliver}
            state={labeled().state("deliver")}
            disabled={busy() || !s().open}
            onChange={(deliver) => setLabel({ deliver })}
            options={DeliverableValues.map((v) => ({ value: v, label: t(`shared.deliverable.${v}`) }))}
          />
        </Property>
      </Show>
      <Property label={t("web.issue.detail.repo")}>{s().repo || t("web.issue.detail.noRepo")}</Property>
      <Property label={t("web.issue.detail.helper")}>{s().whoLine}</Property>
      <Show when={agent()?.model}>{(model) => <Property label={t("web.issue.detail.model")}>{model()}</Property>}</Show>
      <Show when={sideActs().length > 0}>
        <div {...stylex.attrs(styles.issueDetailDiv14)}>
          <For each={sideActs()}>{(a) => button(a, () => !s().ask && a === s().lead)}</For>
        </div>
      </Show>
      <SheetLabel>{t("web.issue.detail.time")}</SheetLabel>
      <Property label={t("web.issue.detail.opened")}>{wallClockText(props.issue.createdAt)}</Property>
      <Property label={t("web.issue.detail.started")}>{wallClockText((props.sessions[0] ?? head()).hiredAt)}</Property>
      <Show when={s().ask && s().stage.since}>
        {(at) => <Property label={t("web.issue.detail.waiting")}>{t("web.issue.detail.since", { clock: wallClockText(at()) })}</Property>}
      </Show>
      <Show when={props.issue.reviewedAt}>
        {(at) => (
          <Property label={t("web.issue.detail.reviewed")}>
            <span {...stylex.attrs(styles.issueDetailSpan42)}>{wallClockText(at())}</span>
          </Property>
        )}
      </Show>
      <Show when={props.issue.closedAt}>{(at) => <Property label={t("web.issue.detail.closedAt")}>{wallClockText(at())}</Property>}</Show>
      <More>
        <Show when={s().crewLine}>
          <Property label={t("web.issue.detail.crew")}>{s().crewLine}</Property>
        </Show>
        <Property label={t("web.issue.detail.profile")}>{agent()?.name ?? head().name}</Property>
        <Show when={head().branch}>
          <Property label={t("web.issue.detail.branch")}>
            <span {...stylex.attrs(styles.issueDetailSpan5)}>{head().branch}</span>
          </Property>
        </Show>
        <Show when={head().worktree}>
          {(worktree) => (
            <Property label="worktree">
              <span {...stylex.attrs(styles.issueDetailSpan6)}>
                <span {...stylex.attrs(styles.issueDetailSpan)}>{worktree()}</span>
                <button
                  type="button"
                  aria-label={t("web.issue.detail.copyPath")}
                  title={t("web.issue.detail.copyPath")}
                  onClick={() => void navigator.clipboard.writeText(worktree())}
                  {...stylex.attrs(styles.issueDetailButton)}
                >
                  <Icon name="copy" size={14} />
                </button>
              </span>
            </Property>
          )}
        </Show>
        <Property label={t("web.issue.detail.took")}>{s().usedLine(steps(), now())}</Property>
        <Show when={s().resolvedFindings.length > 0}>
          <Property label={t("web.issue.detail.resolved")}>
            <For each={s().resolvedFindings}>{(f) => <div {...stylex.attrs(styles.issueDetailDiv15)}>{f.text}</div>}</For>
          </Property>
        </Show>
      </More>
    </>
  );
  return <IssueSheet heading={heading} main={main} side={side} />;
}

/** The issue's title, renamed in place while the issue is open: Enter or leaving the field keeps it, Escape lets it go. */
function IssueTitle(props: { shown: string; full: string; editable: boolean; state: "pending" | "failed" | undefined; onSave: (title: string) => void }) {
  const [editing, setEditing] = createSignal(false);
  const finish = (field: HTMLInputElement, keep: boolean) => {
    if (!editing()) return;
    setEditing(false);
    const title = Str.trim(field.value);
    if (keep && title !== "" && title !== props.full) props.onSave(title);
  };
  return (
    <Show
      when={editing()}
      fallback={
        <h1
          data-testid="issue-title"
          data-state={props.state}
          title={props.full}
          {...stylex.attrs(styles.issueDetailH1, props.state === "pending" && styles.titlePending)}
        >
          <Show when={props.editable} fallback={props.shown}>
            <button type="button" title={t("web.issue.detail.rename")} onClick={() => setEditing(true)} {...stylex.attrs(styles.titleButton)}>
              {props.shown}
            </button>
          </Show>
        </h1>
      }
    >
      <TextInput
        ref={(field) =>
          queueMicrotask(() => {
            field.focus();
            field.select();
          })
        }
        data-testid="issue-title-input"
        aria-label={t("web.issue.detail.rename")}
        value={props.full}
        styles={styles.titleInput}
        onKeyDown={(e) => {
          if (e.isComposing) return;
          if (e.key === "Enter") {
            e.preventDefault();
            finish(e.currentTarget, true);
          } else if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            finish(e.currentTarget, false);
          }
        }}
        onBlur={(e) => finish(e.currentTarget, true)}
      />
    </Show>
  );
}
