import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Issue, IssueAction, IssueAnswer, Milestone, Question as QuestionItem, SessionEvent } from "@vibevalley/protocol";
import { plainText } from "@vibevalley/protocol/rules";

import { tookText, wallClockText } from "#/base/format.ts";
import { perform } from "#/features/issue/model/acts.ts";
import { useIssueRuns } from "#/features/issue/model/history.ts";
import { issueTag, runText, tagOpen, tagText } from "#/features/issue/model/issue.ts";
import { issueMove, issueMoveOf, sendMove } from "#/features/issue/model/moves.ts";
import type { CriterionRow } from "#/features/issue/model/overview.ts";
import { ready } from "#/infra/query.ts";
import { useIntents } from "#/state/intent.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Checkbox } from "#/ui/Checkbox.tsx";
import { Icon } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";

import { ActLines } from "./ActLines";
import { Property } from "./Sheet";

const styles = stylex.create({
  workLogSpan: {
    width: "3rem",
    flexShrink: "0",
  },
  workLogSpanState: {
    color: "var(--wb-muted)",
  },
  workLogSpanState2: {
    color: "var(--wb-water)",
  },
  workLogSpanState3: {
    color: "var(--wb-berry)",
  },
  storySpan: {
    minWidth: "0",
    flex: "1",
    overflowWrap: "break-word",
  },
  storySpanPrimary: {
    color: null,
  },
  storySpanSecondary: {
    color: "var(--color-berry)",
  },
  storySpanStateA: {
    fontWeight: null,
  },
  storySpanStateB: {
    fontWeight: "var(--font-weight-semibold)",
  },
  criteriaIcon: {
    marginTop: "0.125rem",
    flexShrink: "0",
  },
  criteriaSpan: {},
  criteriaSpanTone: {
    color: "var(--color-muted)",
  },
  runsSpan: {
    marginTop: "0.125rem",
    WebkitLineClamp: "2",
    WebkitBoxOrient: "vertical",
    display: "block",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  workLogSpan2: {
    WebkitLineClamp: "3",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    minWidth: "0",
    flex: "1",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    overflowWrap: "break-word",
    whiteSpace: "pre-wrap",
  },
  checklistControl: { marginTop: "0.125rem" },
  questionDiv: {
    marginTop: "0.625rem",
  },
  questionDiv2: {
    marginTop: "0.375rem",
    display: "flex",
    flexWrap: "wrap",
    gap: "0.375rem",
  },
  criteriaUl: {
    display: "flex",
    flexDirection: "column",
  },
  criteriaLi: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.625rem",
    borderRadius: "var(--radius-md)",
    paddingInline: "0.375rem",
    paddingBlock: "0.25rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  criteriaSpan2: {
    marginTop: "0.25rem",
    width: "0.75rem",
    height: "0.75rem",
    flexShrink: "0",
    borderRadius: "9999px",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
  },
  criteriaSpan22: {
    minWidth: "0",
    flex: "1",
  },
  criteriaSpan3: {
    display: "block",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  milestone: {
    display: "flex",
    gap: "0.75rem",
    paddingBlock: "0.25rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  storySpan2: {
    width: "4rem",
    flexShrink: "0",
    color: "var(--color-muted)",
  },
  storySpan22: {
    color: "var(--color-muted)",
  },
  runsP: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-faint)",
  },
  runsDiv: {
    marginBottom: "0.5rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  runsDiv2: {
    display: "flex",
    gap: "0.75rem",
    paddingBottom: "0.5rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  runsSpan2: {
    width: "5rem",
    flexShrink: "0",
    color: "var(--color-muted)",
  },
  workLogOl: {
    maxHeight: "420px",
    overflowY: "auto",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
  },
  workLogLi: {
    display: "flex",
    gap: "0.625rem",
    borderBottomStyle: {
      default: "solid",
      ":last-child": "solid",
    },
    borderBottomWidth: {
      default: "1px",
      ":last-child": "0",
    },
    borderColor: {
      default: "var(--color-line)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-line) 60%, transparent)",
    },
    paddingBlock: "0.25rem",
  },
  workLogSpan3: {
    width: "3.5rem",
    flexShrink: "0",
    color: "var(--color-faint)",
  },
  orchestratorIssueDetailDiv: {
    display: "flex",
    alignItems: "flex-start",
    gap: "0.75rem",
    paddingRight: "2.5rem",
  },
  orchestratorIssueDetailH1: {
    flex: "1",
    fontSize: "var(--text-xl)",
    lineHeight: "var(--leading-xl)",
    fontWeight: "var(--font-weight-semibold)",
  },
  orchestratorIssueDetailSpan: {
    marginTop: "0.375rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  orchestratorIssueDetailDiv2: {
    marginTop: "0.75rem",
  },
  orchestratorIssueDetailDiv3: {
    marginTop: "0.75rem",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
  },
  orchestratorIssueDetailSpan2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-berry)",
  },
  orchestratorIssueDetailDiv4: {
    marginTop: "1rem",
  },
  orchestratorIssueDetailSpan3: {
    fontSize: "var(--text-base)",
    lineHeight: "var(--leading-base)",
  },
  orchestratorIssueDetailH2: {
    marginTop: "1.25rem",
    marginBottom: "0.5rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-semibold)",
  },
  listDiv: {
    marginTop: "0.5rem",
  },
  listDiv2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  listDiv3: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
});

/** A question of the helper's: its options are replies as they are, one click each. */
export function Question(props: { ask: QuestionItem; busy: boolean; onPick: (words: string) => void }) {
  return (
    <div {...stylex.attrs(styles.questionDiv)}>
      <div>{props.ask.question}</div>
      <Show when={props.ask.options.length}>
        <div {...stylex.attrs(styles.questionDiv2)} role="group" aria-label={t("web.issue.detail.answerTo", { question: props.ask.question })}>
          <For each={props.ask.options}>
            {(o) => (
              <Button data-testid="answer-option" data-key={o} disabled={props.busy} onClick={() => props.onPick(o)}>
                {o}
              </Button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

const resultMark: Record<NonNullable<CriterionRow["result"]>, { icon: IconName; label: string }> = {
  met: { icon: "check", label: t("web.issue.detail.result.met") },
  unmet: { icon: "cross", label: t("web.issue.detail.result.unmet") },
  unsure: { icon: "warn", label: t("web.issue.detail.result.unsure") },
};

/** The criteria with the helper's word on each; while it is judged, each can be ticked off as the user checks it (on
 * this page only). */
export function Criteria(props: { rows: CriterionRow[]; checking: boolean }) {
  const [ticked, setTicked] = createSignal<ReadonlySet<number>>(new Set());
  const tick = (i: number) =>
    setTicked((was) => {
      const n = new Set(was);
      if (n.has(i)) n.delete(i);
      else n.add(i);
      return n;
    });
  return (
    <ul {...stylex.attrs(styles.criteriaUl)}>
      <For each={props.rows} keyed={(r) => r.text}>
        {(r, i) => (
          <li {...stylex.attrs(styles.criteriaLi)}>
            <Show when={props.checking}>
              <Checkbox
                testid="criterion-tick"
                data-key={i()}
                label={t("web.issue.detail.ticked", { criterion: r().text })}
                checked={ticked().has(i())}
                onChange={() => tick(i())}
                styles={styles.checklistControl}
              />
            </Show>
            <Show when={r().result} fallback={<span {...stylex.attrs(styles.criteriaSpan2)} title={t("web.issue.detail.unsaid")} />}>
              {(res) => <Icon name={resultMark[res()].icon} size={14} label={resultMark[res()].label} styles={[styles.criteriaIcon]} />}
            </Show>
            <span {...stylex.attrs(styles.criteriaSpan22)}>
              <span {...stylex.attrs(styles.criteriaSpan, ticked().has(i()) ? styles.criteriaSpanTone : styles.criteriaSpan)}>{r().text}</span>
              <Show when={r().proof}>
                <span {...stylex.attrs(styles.criteriaSpan3)}>{r().proof}</span>
              </Show>
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}

/** The milestones, newest first: when, who, what. */
export function Story(props: { milestones: Milestone[] }) {
  return (
    <ol {...stylex.attrs(styles.criteriaUl)}>
      <For each={props.milestones}>
        {(m) => (
          <li data-testid="milestone" data-kind={m.kind} {...stylex.attrs(styles.milestone)}>
            <span {...stylex.attrs(styles.storySpan2)}>{wallClockText(m.at)}</span>
            <span
              {...stylex.attrs(
                styles.storySpan,
                m.kind === "failed" || m.kind === "rejected" ? styles.storySpanSecondary : styles.storySpanPrimary,
                m.kind === "asked" ? styles.storySpanStateB : styles.storySpanStateA,
              )}
            >
              <Show when={m.who}>
                <span {...stylex.attrs(styles.storySpan22)}>{m.who} · </span>
              </Show>
              {plainText(m.text)}
            </span>
          </li>
        )}
      </For>
    </ol>
  );
}

/** The runs of an issue, read again whenever `version` changes. */
export function Runs(props: { issue: string; version: string }) {
  const query = useIssueRuns(
    () => props.issue,
    () => props.version,
  );
  const runs = () => ready(query, []);
  const now = () => Date.now();
  return (
    <Show when={runs().length > 0} fallback={<p {...stylex.attrs(styles.runsP)}>{t("web.issue.detail.noRuns")}</p>}>
      <div>
        <div {...stylex.attrs(styles.runsDiv)}>{t("web.issue.detail.runCount", { n: runs().length })}</div>
        <For each={[...runs()].toReversed()}>
          {(r) => (
            <div {...stylex.attrs(styles.runsDiv2)}>
              <span {...stylex.attrs(styles.runsSpan2)}>{wallClockText(r.startedAt)}</span>
              <span {...stylex.attrs(styles.criteriaSpan22)}>
                {runText(r, now(), tookText)}
                <Show when={r.summary}>
                  <span {...stylex.attrs(styles.runsSpan)}>{r.summary}</span>
                </Show>
              </span>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
}

export const stepsLine = (steps: SessionEvent[]) => {
  const tools = steps.filter((e) => e.type === "tool/call").length;
  return tools === 0 ? t("web.issue.detail.stepCount", { n: steps.length }) : t("web.issue.detail.stepsAndTools", { n: steps.length, tools });
};

const stepWord: Partial<Record<SessionEvent["type"], string>> = {
  "run/start": t("web.issue.detail.step.run/start"),
  "user/message": t("web.issue.detail.step.user/message"),
  "memory/recalled": t("web.issue.detail.step.memory/recalled"),
  "assistant/thinking": t("web.issue.detail.step.assistant/thinking"),
  "assistant/message": t("web.issue.detail.step.assistant/message"),
  "tool/call": t("web.issue.detail.step.tool/call"),
  "llm/retry": t("web.issue.detail.step.llm/retry"),
  "run/error": t("web.issue.detail.step.run/error"),
  "run/end": t("web.issue.detail.step.run/end"),
};

/** The session's steps, newest last; tool results and usage are left to the farm's fuller log. */
export function WorkLog(props: { steps: SessionEvent[] }) {
  const shown = () => props.steps.filter((e) => stepWord[e.type] !== undefined).slice(-240);
  return (
    <ol {...stylex.attrs(styles.workLogOl)}>
      <For each={shown()}>
        {(e) => (
          <li {...stylex.attrs(styles.workLogLi)}>
            <span {...stylex.attrs(styles.workLogSpan3)}>{wallClockText(e.time)}</span>
            <span
              {...stylex.attrs(
                styles.workLogSpan,
                e.type === "run/error" ? styles.workLogSpanState3 : e.type === "tool/call" ? styles.workLogSpanState2 : styles.workLogSpanState,
              )}
            >
              {stepWord[e.type]}
            </span>
            <span {...stylex.attrs(styles.workLogSpan2)}>{e.type === "tool/call" ? (e.actionText ?? e.text) : e.text}</span>
          </li>
        )}
      </For>
    </ol>
  );
}

/** An issue for the orchestrator: what it was asked, and its runs; the answers are in its channel. */
export function OrchestratorIssueDetail(props: { issue: Issue }) {
  const tag = () => issueTag(props.issue);
  const act = createAct();
  const moves = useIntents(issueMove);
  const move = () => issueMoveOf(props.issue.id, moves.list());
  const busy = () => act.busy() || move()?.state === "moving";
  // The orchestrator's answer is the user's to take as done or put away; one that did not end well can only be put away.
  const go = (a: IssueAction) => {
    const issue = props.issue;
    if (a.does === "move") void sendMove(moves, { id: issue.id, status: a.status });
    else void act.run(() => perform(issue, a));
  };
  return (
    <div>
      <div {...stylex.attrs(styles.orchestratorIssueDetailDiv)}>
        <h1 {...stylex.attrs(styles.orchestratorIssueDetailH1)}>{props.issue.title}</h1>
        <span {...stylex.attrs(styles.orchestratorIssueDetailSpan)}>{tagText(props.issue)}</span>
      </div>
      <div {...stylex.attrs(styles.orchestratorIssueDetailDiv2)}>
        <ActLines issue={props.issue.id} />
      </div>
      <Show when={props.issue.stage.acts.length > 0}>
        <div {...stylex.attrs(styles.orchestratorIssueDetailDiv3)}>
          <Show when={props.issue.stage.state === "stuck"}>
            <span {...stylex.attrs(styles.orchestratorIssueDetailSpan2)}>{t("web.issue.detail.orchestratorStuck")}</span>
          </Show>
          <For each={props.issue.stage.acts}>
            {(a) => (
              <Button data-act={a.act} tone={a.act === props.issue.stage.lead ? "primary" : "plain"} disabled={busy()} onClick={() => go(a)}>
                {t(`shared.act.${a.act}`)}
              </Button>
            )}
          </For>
        </div>
      </Show>
      <div {...stylex.attrs(styles.orchestratorIssueDetailDiv4)}>
        <Property label={t("web.issue.detail.who")}>{t("web.issue.orchestrator")}</Property>
        <Show when={props.issue.description}>
          <Property label={t("web.issue.detail.job")}>
            <span {...stylex.attrs(styles.orchestratorIssueDetailSpan3)}>{props.issue.description}</span>
          </Property>
        </Show>
        <Show when={props.issue.cron}>
          <Property label={t("web.issue.detail.from")}>{t("web.issue.detail.fromCron")}</Property>
        </Show>
        <Property label={t("web.issue.detail.opened")}>{wallClockText(props.issue.createdAt)}</Property>
        <Show when={props.issue.closedAt}>{(at) => <Property label={t("web.issue.detail.closedAt")}>{wallClockText(at())}</Property>}</Show>
        <Property label={t("web.issue.detail.answer")}>{t("web.issue.detail.answered")}</Property>
      </div>
      <h2 {...stylex.attrs(styles.orchestratorIssueDetailH2)}>{t("web.issue.detail.runs")}</h2>
      <Runs issue={props.issue.id} version={`${props.issue.status}:${props.issue.closedAt}:${tagOpen(tag())}`} />
    </div>
  );
}

/** An answer issue's conclusion: the answer, what it rests on, what it is unsure of, what to do next. */
export function AnswerView(props: { answer: IssueAnswer }) {
  const list = (head: string, lines: readonly string[]) => (
    <Show when={lines.length > 0}>
      <div {...stylex.attrs(styles.listDiv)}>
        <div {...stylex.attrs(styles.listDiv2)}>{head}</div>
        <For each={lines}>{(l) => <div {...stylex.attrs(styles.listDiv3)}>· {l}</div>}</For>
      </div>
    </Show>
  );
  return (
    <div>
      <p {...stylex.attrs(styles.orchestratorIssueDetailSpan3)}>{props.answer.conclusion}</p>
      {list(t("web.issue.detail.evidence"), props.answer.evidence)}
      {list(t("web.issue.detail.unsure"), props.answer.unsure)}
      {list(t("web.issue.detail.next"), props.answer.next)}
    </div>
  );
}
