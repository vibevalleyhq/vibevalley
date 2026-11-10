import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Issue, IssueAction, IssueAnswer, Milestone, Question as QuestionItem, SessionEvent } from "@vibevalley/protocol";
import { plainText } from "@vibevalley/protocol/rules";

import { tookText, wallClockText } from "#/base/format.ts";
import { ready } from "#/infra/query.ts";
import { useIntents } from "#/state/intent.ts";
import { createAct } from "#/ui/act.ts";
import { Button } from "#/ui/Button.tsx";
import { Checkbox } from "#/ui/Checkbox.tsx";
import { Icon } from "#/ui/Icon.tsx";
import type { IconName } from "#/ui/icons.ts";

import { ActLines } from "./ActLines";
import { perform } from "./acts";
import { useIssueRuns } from "./history";
import { issueTag, runText, tagOpen, tagText } from "./issue";
import { issueMove, issueMoveOf, sendMove } from "./moves";
import type { CriterionRow } from "./overview";
import { Property } from "./Sheet";

const recipeStyles2 = stylex.create({
  workLogSpan: {
    width: "calc(var(--spacing) * 12)",
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
});

const recipeStyles = stylex.create({
  storySpan: {
    minWidth: "0",
    flex: "1",
    overflowWrap: "break-word",
  },
  storySpanVariant1Case1: {
    color: null,
  },
  storySpanVariant1Case2: {
    color: "var(--color-berry)",
  },
  storySpanVariant2Case1: {
    fontWeight: null,
  },
  storySpanVariant2Case2: {
    fontWeight: "var(--font-weight-semibold)",
  },
});

const variantStyles2 = stylex.create({
  criteriaIcon: {
    marginTop: "calc(var(--spacing) * .5)",
    flexShrink: "0",
  },
});

const variantStyles = stylex.create({
  criteriaSpan: {},
  criteriaSpanVariant: {
    color: "var(--color-muted)",
  },
  runsSpan: {
    marginTop: "calc(var(--spacing) * .5)",
    WebkitLineClamp: "2",
    WebkitBoxOrient: "vertical",
    display: "block",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  workLogSpan: {
    WebkitLineClamp: "3",
    WebkitBoxOrient: "vertical",
    display: "-webkit-box",
    overflow: "hidden",
    minWidth: "0",
    flex: "1",
    fontFamily: "var(--font-sans)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    overflowWrap: "break-word",
    whiteSpace: "pre-wrap",
  },
});

const viewStyles = stylex.create({
  checklistControl: { marginTop: "calc(var(--spacing) * 0.5)" },
  questionDiv: {
    marginTop: "calc(var(--spacing) * 2.5)",
  },
  questionDiv2: {
    marginTop: "calc(var(--spacing) * 1.5)",
    display: "flex",
    flexWrap: "wrap",
    gap: "calc(var(--spacing) * 1.5)",
  },
  criteriaUl: {
    display: "flex",
    flexDirection: "column",
  },
  criteriaLi: {
    display: "flex",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 2.5)",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 1.5)",
    paddingBlock: "var(--spacing)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  criteriaSpan: {
    marginTop: "var(--spacing)",
    width: "calc(var(--spacing) * 3)",
    height: "calc(var(--spacing) * 3)",
    flexShrink: "0",
    borderRadius: "2147483647px",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-line)",
  },
  criteriaSpan2: {
    minWidth: "0",
    flex: "1",
  },
  criteriaSpan3: {
    display: "block",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  milestone: {
    display: "flex",
    gap: "calc(var(--spacing) * 3)",
    paddingBlock: "var(--spacing)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  storySpan: {
    width: "calc(var(--spacing) * 16)",
    flexShrink: "0",
    color: "var(--color-muted)",
  },
  storySpan2: {
    color: "var(--color-muted)",
  },
  runsP: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-faint)",
  },
  runsDiv: {
    marginBottom: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  runsDiv2: {
    display: "flex",
    gap: "calc(var(--spacing) * 3)",
    paddingBottom: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  runsSpan: {
    width: "calc(var(--spacing) * 20)",
    flexShrink: "0",
    color: "var(--color-muted)",
  },
  workLogOl: {
    maxHeight: "420px",
    overflowY: "auto",
    fontFamily: "var(--font-mono)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
  },
  workLogLi: {
    display: "flex",
    gap: "calc(var(--spacing) * 2.5)",
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
    paddingBlock: "var(--spacing)",
  },
  workLogSpan: {
    width: "calc(var(--spacing) * 14)",
    flexShrink: "0",
    color: "var(--color-faint)",
  },
  orchestratorIssueDetailDiv: {
    display: "flex",
    alignItems: "flex-start",
    gap: "calc(var(--spacing) * 3)",
    paddingRight: "calc(var(--spacing) * 10)",
  },
  orchestratorIssueDetailH1: {
    flex: "1",
    fontSize: "var(--text-xl)",
    lineHeight: "var(--text-xl--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  orchestratorIssueDetailSpan: {
    marginTop: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  orchestratorIssueDetailDiv2: {
    marginTop: "calc(var(--spacing) * 3)",
  },
  orchestratorIssueDetailDiv3: {
    marginTop: "calc(var(--spacing) * 3)",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  orchestratorIssueDetailSpan2: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--color-berry)",
  },
  orchestratorIssueDetailDiv4: {
    marginTop: "calc(var(--spacing) * 4)",
  },
  orchestratorIssueDetailSpan3: {
    fontSize: "var(--text-base)",
    lineHeight: "var(--text-base--line-height)",
  },
  orchestratorIssueDetailH2: {
    marginTop: "calc(var(--spacing) * 5)",
    marginBottom: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  listDiv: {
    marginTop: "calc(var(--spacing) * 2)",
  },
  listDiv2: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  listDiv3: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
});

/** A question of the helper's: its options are replies as they are, one click each. */
export function Question(props: { ask: QuestionItem; busy: boolean; onPick: (words: string) => void }) {
  return (
    <div {...stylex.attrs(viewStyles.questionDiv)}>
      <div>{props.ask.question}</div>
      <Show when={props.ask.options.length}>
        <div {...stylex.attrs(viewStyles.questionDiv2)} role="group" aria-label={t("web.issue.detail.answerTo", { question: props.ask.question })}>
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
    <ul {...stylex.attrs(viewStyles.criteriaUl)}>
      <For each={props.rows} keyed={(r) => r.text}>
        {(r, i) => (
          <li {...stylex.attrs(viewStyles.criteriaLi)}>
            <Show when={props.checking}>
              <Checkbox
                testid="criterion-tick"
                data-key={i()}
                label={t("web.issue.detail.ticked", { criterion: r().text })}
                checked={ticked().has(i())}
                onChange={() => tick(i())}
                styles={viewStyles.checklistControl}
              />
            </Show>
            <Show when={r().result} fallback={<span {...stylex.attrs(viewStyles.criteriaSpan)} title={t("web.issue.detail.unsaid")} />}>
              {(res) => <Icon name={resultMark[res()].icon} size={14} label={resultMark[res()].label} styles={[variantStyles2.criteriaIcon]} />}
            </Show>
            <span {...stylex.attrs(viewStyles.criteriaSpan2)}>
              <span {...stylex.attrs(variantStyles.criteriaSpan, ticked().has(i()) ? variantStyles.criteriaSpanVariant : variantStyles.criteriaSpan)}>
                {r().text}
              </span>
              <Show when={r().proof}>
                <span {...stylex.attrs(viewStyles.criteriaSpan3)}>{r().proof}</span>
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
    <ol {...stylex.attrs(viewStyles.criteriaUl)}>
      <For each={props.milestones}>
        {(m) => (
          <li data-testid="milestone" data-kind={m.kind} {...stylex.attrs(viewStyles.milestone)}>
            <span {...stylex.attrs(viewStyles.storySpan)}>{wallClockText(m.at)}</span>
            <span
              {...stylex.attrs(
                recipeStyles.storySpan,
                m.kind === "failed" || m.kind === "rejected" ? recipeStyles.storySpanVariant1Case2 : recipeStyles.storySpanVariant1Case1,
                m.kind === "asked" ? recipeStyles.storySpanVariant2Case2 : recipeStyles.storySpanVariant2Case1,
              )}
            >
              <Show when={m.who}>
                <span {...stylex.attrs(viewStyles.storySpan2)}>{m.who} · </span>
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
    <Show when={runs().length > 0} fallback={<p {...stylex.attrs(viewStyles.runsP)}>{t("web.issue.detail.noRuns")}</p>}>
      <div>
        <div {...stylex.attrs(viewStyles.runsDiv)}>{t("web.issue.detail.runCount", { n: runs().length })}</div>
        <For each={[...runs()].toReversed()}>
          {(r) => (
            <div {...stylex.attrs(viewStyles.runsDiv2)}>
              <span {...stylex.attrs(viewStyles.runsSpan)}>{wallClockText(r.startedAt)}</span>
              <span {...stylex.attrs(viewStyles.criteriaSpan2)}>
                {runText(r, now(), tookText)}
                <Show when={r.summary}>
                  <span {...stylex.attrs(variantStyles.runsSpan)}>{r.summary}</span>
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
    <ol {...stylex.attrs(viewStyles.workLogOl)}>
      <For each={shown()}>
        {(e) => (
          <li {...stylex.attrs(viewStyles.workLogLi)}>
            <span {...stylex.attrs(viewStyles.workLogSpan)}>{wallClockText(e.time)}</span>
            <span
              {...stylex.attrs(
                recipeStyles2.workLogSpan,
                e.type === "run/error"
                  ? recipeStyles2.workLogSpanState3
                  : e.type === "tool/call"
                    ? recipeStyles2.workLogSpanState2
                    : recipeStyles2.workLogSpanState,
              )}
            >
              {stepWord[e.type]}
            </span>
            <span {...stylex.attrs(variantStyles.workLogSpan)}>{e.type === "tool/call" ? (e.actionText ?? e.text) : e.text}</span>
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
      <div {...stylex.attrs(viewStyles.orchestratorIssueDetailDiv)}>
        <h1 {...stylex.attrs(viewStyles.orchestratorIssueDetailH1)}>{props.issue.title}</h1>
        <span {...stylex.attrs(viewStyles.orchestratorIssueDetailSpan)}>{tagText(props.issue)}</span>
      </div>
      <div {...stylex.attrs(viewStyles.orchestratorIssueDetailDiv2)}>
        <ActLines issue={props.issue.id} />
      </div>
      <Show when={props.issue.stage.acts.length > 0}>
        <div {...stylex.attrs(viewStyles.orchestratorIssueDetailDiv3)}>
          <Show when={props.issue.stage.state === "stuck"}>
            <span {...stylex.attrs(viewStyles.orchestratorIssueDetailSpan2)}>{t("web.issue.detail.orchestratorStuck")}</span>
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
      <div {...stylex.attrs(viewStyles.orchestratorIssueDetailDiv4)}>
        <Property label={t("web.issue.detail.who")}>{t("web.issue.orchestrator")}</Property>
        <Show when={props.issue.description}>
          <Property label={t("web.issue.detail.job")}>
            <span {...stylex.attrs(viewStyles.orchestratorIssueDetailSpan3)}>{props.issue.description}</span>
          </Property>
        </Show>
        <Show when={props.issue.cron}>
          <Property label={t("web.issue.detail.from")}>{t("web.issue.detail.fromCron")}</Property>
        </Show>
        <Property label={t("web.issue.detail.opened")}>{wallClockText(props.issue.createdAt)}</Property>
        <Show when={props.issue.closedAt}>{(at) => <Property label={t("web.issue.detail.closedAt")}>{wallClockText(at())}</Property>}</Show>
        <Property label={t("web.issue.detail.answer")}>{t("web.issue.detail.answered")}</Property>
      </div>
      <h2 {...stylex.attrs(viewStyles.orchestratorIssueDetailH2)}>{t("web.issue.detail.runs")}</h2>
      <Runs issue={props.issue.id} version={`${props.issue.status}:${props.issue.closedAt}:${tagOpen(tag())}`} />
    </div>
  );
}

/** An answer issue's conclusion: the answer, what it rests on, what it is unsure of, what to do next. */
export function AnswerView(props: { answer: IssueAnswer }) {
  const list = (head: string, lines: readonly string[]) => (
    <Show when={lines.length > 0}>
      <div {...stylex.attrs(viewStyles.listDiv)}>
        <div {...stylex.attrs(viewStyles.listDiv2)}>{head}</div>
        <For each={lines}>{(l) => <div {...stylex.attrs(viewStyles.listDiv3)}>· {l}</div>}</For>
      </div>
    </Show>
  );
  return (
    <div>
      <p {...stylex.attrs(viewStyles.orchestratorIssueDetailSpan3)}>{props.answer.conclusion}</p>
      {list(t("web.issue.detail.evidence"), props.answer.evidence)}
      {list(t("web.issue.detail.unsure"), props.answer.unsure)}
      {list(t("web.issue.detail.next"), props.answer.next)}
    </div>
  );
}
