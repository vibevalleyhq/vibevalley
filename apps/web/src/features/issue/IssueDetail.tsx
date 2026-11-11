import * as stylex from "@stylexjs/stylex";
import { Array as Arr, String as Str } from "effect";
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";

import { list, t } from "@vibevalley/i18n";
import { DeliverableValues, type Issue, type IssueAct, PriorityValues, type Session, type SessionView } from "@vibevalley/protocol";
import { closedText, plainText } from "@vibevalley/protocol/rules";

import { useNow } from "#/base/dom.tsx";
import { wallClockText } from "#/base/format.ts";
import { IssueArtifacts } from "#/features/artifact/index.ts";
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
import { createIssueActs } from "./acts";
import { changesLine } from "./changes";
import { ChangesBody, ChangesHead } from "./CloseDialog";
import { useIssueChanges, useIssues, useIssueTimeline } from "./history";
import { AnswerView, Criteria, OrchestratorIssueDetail, Question, Runs, stepsLine, Story, WorkLog } from "./IssueSections";
import { IssueThread } from "./IssueThread";
import { issueMove, movedIssue } from "./moves";
import { issueState, noStepsText, stageTone } from "./overview";
import { Fold, IssueSheet, More, Note, Pick, Property, SheetLabel } from "./Sheet";
import { issueSet, labeledIssue, sendLabel } from "./write";

const recipeStyles2 = stylex.create({
  issueDetailSpan: {
    minWidth: "0",
    flex: "1",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    wordBreak: "break-all",
    WebkitUserSelect: "text",
    userSelect: "text",
  },
});

const variantStyles3 = stylex.create({
  issueDetailMarkdown: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-ink)",
  },
});

const variantStyles2 = stylex.create({
  issueDetailTextArea: {
    marginTop: "calc(var(--spacing) * 2.5)",
  },
});

const variantStyles = stylex.create({
  issueDetailH1: {
    WebkitLineClamp: "2",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    minWidth: "0",
    flex: "1",
    fontSize: "var(--text-lg)",
    lineHeight: "var(--text-lg--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  issueDetailSpan: {},
  issueDetailSpanVariant: {
    color: "var(--color-berry)",
  },
  issueDetailSpanVariant2: {
    color: {
      default: "var(--color-ink)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-ink) 80%, transparent)",
    },
  },
  issueDetailDiv: {
    marginTop: "var(--spacing)",
    WebkitLineClamp: "4",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
  },
});

const titleStyles = stylex.create({
  button: {
    cursor: "text",
    borderRadius: "var(--radius-sm)",
    marginInline: "calc(var(--spacing) * -1)",
    paddingInline: "var(--spacing)",
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
  input: {
    minWidth: "0",
    flex: "1",
    fontSize: "var(--text-lg)",
    lineHeight: "var(--text-lg--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  pending: {
    opacity: "0.7",
  },
});

const viewStyles = stylex.create({
  issueDetailDiv: {
    paddingRight: "calc(var(--spacing) * 10)",
  },
  trail: {
    marginBottom: "calc(var(--spacing) * 1.5)",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  parentIssue: {
    cursor: "pointer",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-water)",
    textDecorationLine: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "underline",
      },
    },
  },
  issueDetailDiv2: {
    containerType: "inline-size",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "baseline",
    columnGap: "calc(var(--spacing) * 2)",
  },
  issueDetailSpan: {
    flexShrink: "0",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  issueNow: {
    marginTop: "calc(var(--spacing) * 1.5)",
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  issueAsk: {
    marginBottom: "calc(var(--spacing) * 5)",
  },
  issueDetailDiv3: {
    fontWeight: "var(--font-weight-semibold)",
  },
  issueDetailDiv4: {
    marginTop: "calc(var(--spacing) * 2.5)",
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 2)",
  },
  issueDetailDiv5: {
    marginTop: "calc(var(--spacing) * 2)",
    display: "flex",
    gap: "calc(var(--spacing) * 2)",
  },
  issueDetailSpan2: {
    marginLeft: "calc(var(--spacing) * 2)",
    fontWeight: "var(--font-weight-normal)",
  },
  issueDetailDiv6: {
    marginBottom: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-water)",
  },
  issueDetailDiv7: {
    marginBottom: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  issueDetailP: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-muted)",
  },
  issueDetailDiv8: {
    marginTop: "calc(var(--spacing) * 2)",
  },
  issueDetailDiv9: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  issueDetailDiv10: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-berry)",
  },
  issueDetailDiv11: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
  },
  issueDetailDiv12: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  issueDetailA: {
    marginTop: "var(--spacing)",
    display: "block",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
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
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-faint)",
  },
  issueDetailDiv13: {
    marginTop: "calc(var(--spacing) * 3)",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-line)",
  },
  issueDetailSummary: {
    cursor: "pointer",
    paddingBlock: "calc(var(--spacing) * 2.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  issueDetailSpan3: {
    marginLeft: "calc(var(--spacing) * 2)",
    fontWeight: "var(--font-weight-normal)",
    color: "var(--color-muted)",
  },
  issueDetailDiv14: {
    marginBlock: "calc(var(--spacing) * 3)",
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 2)",
  },
  issueDetailSpan4: {
    color: "var(--color-accent)",
  },
  issueDetailSpan5: {
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  issueDetailSpan6: {
    display: "flex",
    alignItems: "flex-start",
    gap: "var(--spacing)",
  },
  issueDetailButton: {
    cursor: "pointer",
    borderRadius: "var(--radius-sm)",
    padding: "calc(var(--spacing) * .5)",
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
    <div {...stylex.attrs(viewStyles.issueDetailDiv)}>
      <nav aria-label={t("web.issue.detail.trail")} data-testid="issue-trail" {...stylex.attrs(viewStyles.trail)}>
        <span>{s().repo || t("web.issue.detail.noRepo")}</span>
        <Show when={s().inFamily ? props.onParent : undefined}>
          {(onParent) => (
            <>
              <Icon name="next" size={12} />
              <button type="button" data-testid="parent-issue" onClick={() => onParent()()} {...stylex.attrs(viewStyles.parentIssue)}>
                {parent()?.title ?? t("web.issue.family.parent")}
              </button>
            </>
          )}
        </Show>
        <Icon name="next" size={12} />
        <span {...stylex.attrs(viewStyles.issueDetailSpan)}>#{props.issue.number}</span>
      </nav>
      <div {...stylex.attrs(viewStyles.issueDetailDiv2)}>
        <IssueTitle shown={s().title} full={live().title} editable={s().open} state={labeled().state("title")} onSave={(title) => setLabel({ title })} />
      </div>
      <div {...stylex.attrs(viewStyles.issueNow)} aria-label={t("web.issue.detail.now")} data-testid="issue-now" data-state={s().stage.state}>
        <Dot tone={tone()} size={8} ring={false} />
        <span>{t(`shared.status.${live().status}`)} ·</span>
        <span
          {...stylex.attrs(variantStyles.issueDetailSpan, tone() === "berry" ? variantStyles.issueDetailSpanVariant : variantStyles.issueDetailSpanVariant2)}
        >
          {s().statusLine(now(), timeline()?.spent?.cny)}
        </span>
      </div>
    </div>
  );

  const main = (
    <>
      <Show when={s().description}>
        <section data-testid="issue-requirement">
          <SheetLabel>{t("web.issue.detail.full")}</SheetLabel>
          <Markdown styles={variantStyles3.issueDetailMarkdown} text={s().description} />
        </section>
      </Show>
      <ActLines issue={props.issue.id} words={acts.words()} onSayAgain={acts.sayAgain} onTakeBack={acts.takeBack} />
      <Show when={s().ask}>
        {(ask) => (
          <section aria-label={t("web.issue.detail.yours")} data-testid="issue-ask" {...stylex.attrs(viewStyles.issueAsk)}>
            <SheetLabel>{t("web.issue.detail.yours")}</SheetLabel>
            <Note tone={ask().tone}>
              <div {...stylex.attrs(viewStyles.issueDetailDiv3)}>{ask().head}</div>
              <Show when={ask().line}>{(line) => <div {...stylex.attrs(variantStyles.issueDetailDiv)}>{plainText(line())}</div>}</Show>
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
                styles={variantStyles2.issueDetailTextArea}
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
            <div {...stylex.attrs(viewStyles.issueDetailDiv4)}>
              <Show when={s().lead} keyed>
                {(lead) => button(lead, () => true)}
              </Show>
              <For each={s().others.filter((a) => a !== "close" && a !== "stop")}>{(a) => button(a, () => false)}</For>
            </div>
          </section>
        )}
      </Show>
      <Show when={!s().ask && box() === "tell"}>
        <section aria-label={t("web.issue.detail.tellSection")} {...stylex.attrs(viewStyles.issueAsk)}>
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
          <div {...stylex.attrs(viewStyles.issueDetailDiv5)}>
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
            <span {...stylex.attrs(viewStyles.issueDetailSpan2)}>{t("web.issue.detail.met", { met: s().met, of: s().criteria.length })}</span>
          </Show>
        </SheetLabel>
        <Show when={s().doing}>
          <div {...stylex.attrs(viewStyles.issueDetailDiv6)}>{s().doing}</div>
        </Show>
        <Show when={s().inFamily}>
          <div {...stylex.attrs(viewStyles.issueDetailDiv7)}>{s().parentText}</div>
        </Show>
        <Show
          when={s().criteria.length > 0}
          fallback={<p {...stylex.attrs(viewStyles.issueDetailP)}>{t("web.issue.detail.noCriteria", { answer: live().deliver === "answer" })}</p>}
        >
          <Criteria rows={s().criteria} checking={s().stage.state === "reviewing" && props.issue.reviewedAt === undefined} />
        </Show>
        <Show when={s().openFindings.length > 0}>
          <div {...stylex.attrs(viewStyles.issueDetailDiv8)}>
            <div {...stylex.attrs(viewStyles.issueDetailDiv9)}>{t("web.issue.detail.rejected")}</div>
            <For each={s().openFindings}>{(f) => <div {...stylex.attrs(viewStyles.issueDetailDiv10)}>· {f.text}</div>}</For>
          </div>
        </Show>
      </section>

      <section aria-label={t("web.issue.detail.made")} data-testid="issue-made">
        <SheetLabel>{t("web.issue.detail.made")}</SheetLabel>
        <Switch
          fallback={
            <p {...stylex.attrs(viewStyles.issueDetailP)}>
              {s().stage.state === "done" ? t("shared.join.sentence", { text: closedText(props.issue) }) : t("web.issue.detail.nothingToSee")}
            </p>
          }
        >
          <Match when={live().deliver === "answer"}>
            <Show when={props.issue.answer} fallback={<p {...stylex.attrs(viewStyles.issueDetailP)}>{t("web.issue.detail.noAnswer")}</p>}>
              {(a) => <AnswerView answer={a()} />}
            </Show>
          </Match>
          <Match when={s().showsChanges && changes()}>
            {(c) => (
              <Show
                when={c().commits.length > 0 || c().uncommitted.length > 0 || c().files.length > 0}
                fallback={<p {...stylex.attrs(viewStyles.issueDetailP)}>{t("web.issue.detail.noChanges")}</p>}
              >
                <div {...stylex.attrs(viewStyles.issueDetailDiv11)}>
                  <div {...stylex.attrs(viewStyles.issueDetailDiv12)}>{changesLine(c())}</div>
                  <Show when={c().conflicts.length > 0}>
                    <div {...stylex.attrs(viewStyles.issueDetailDiv10)}>{t("web.issue.detail.conflict", { base: c().base, files: list(c().conflicts) })}</div>
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
            <p {...stylex.attrs(viewStyles.issueDetailP)}>
              {changesQuery.status() === "pending" ? t("web.issue.reading") : t("web.issue.detail.changesUnread")}
            </p>
          </Match>
        </Switch>
        <Show when={props.issue.pullRequest}>
          {(pr) => (
            <a href={pr().url} target="_blank" rel="noreferrer" {...stylex.attrs(viewStyles.issueDetailA)}>
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
            <p {...stylex.attrs(viewStyles.issueDetailP2)}>{timelineQuery.status() === "pending" ? t("web.issue.reading") : t("web.issue.detail.unread")}</p>
          }
        >
          {(line) => <Story milestones={line().milestones} />}
        </Show>
        <div {...stylex.attrs(viewStyles.issueDetailDiv13)}>
          <details onToggle={(event) => setShowSteps(event.currentTarget.open)}>
            <summary {...stylex.attrs(viewStyles.issueDetailSummary)}>
              {t("web.issue.detail.steps")}
              <Show when={steps().length > 0}>
                <span {...stylex.attrs(viewStyles.issueDetailSpan3)}>{stepsLine(steps())}</span>
              </Show>
            </summary>
            <Show when={showSteps()}>
              <Show when={steps().length > 0 ? steps() : undefined} fallback={<p {...stylex.attrs(viewStyles.issueDetailP2)}>{noStepsText(head())}</p>}>
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
        <div {...stylex.attrs(viewStyles.issueDetailDiv14)}>
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
            <span {...stylex.attrs(viewStyles.issueDetailSpan4)}>{wallClockText(at())}</span>
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
            <span {...stylex.attrs(viewStyles.issueDetailSpan5)}>{head().branch}</span>
          </Property>
        </Show>
        <Show when={head().worktree}>
          {(worktree) => (
            <Property label="worktree">
              <span {...stylex.attrs(viewStyles.issueDetailSpan6)}>
                <span {...stylex.attrs(recipeStyles2.issueDetailSpan)}>{worktree()}</span>
                <button
                  type="button"
                  aria-label={t("web.issue.detail.copyPath")}
                  title={t("web.issue.detail.copyPath")}
                  onClick={() => void navigator.clipboard.writeText(worktree())}
                  {...stylex.attrs(viewStyles.issueDetailButton)}
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
            <For each={s().resolvedFindings}>{(f) => <div {...stylex.attrs(viewStyles.issueDetailDiv15)}>{f.text}</div>}</For>
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
          {...stylex.attrs(variantStyles.issueDetailH1, props.state === "pending" && titleStyles.pending)}
        >
          <Show when={props.editable} fallback={props.shown}>
            <button type="button" title={t("web.issue.detail.rename")} onClick={() => setEditing(true)} {...stylex.attrs(titleStyles.button)}>
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
        styles={titleStyles.input}
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
