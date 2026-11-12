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

/** A question of the helper's: its options are replies as they are, one click each. */
export function Question(props: { ask: QuestionItem; busy: boolean; onPick: (words: string) => void }) {
  return (
    <div class="mt-2.5">
      <div>{props.ask.question}</div>
      <Show when={props.ask.options.length}>
        <div class="mt-1.5 flex flex-wrap gap-1.5" role="group" aria-label={t("web.issue.detail.answerTo", { question: props.ask.question })}>
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
    <ul class="flex flex-col">
      <For each={props.rows} keyed={(r) => r.text}>
        {(r, i) => (
          <li class="flex items-start gap-2.5 rounded-md px-1.5 py-1 text-sm">
            <Show when={props.checking}>
              <Checkbox
                testid="criterion-tick"
                data-key={i()}
                label={t("web.issue.detail.ticked", { criterion: r().text })}
                checked={ticked().has(i())}
                onChange={() => tick(i())}
                class="mt-0.5"
              />
            </Show>
            <Show when={r().result} fallback={<span class="mt-1 w-3 h-3 shrink-0 rounded-full border border-line" title={t("web.issue.detail.unsaid")} />}>
              {(res) => <Icon name={resultMark[res()].icon} size={14} label={resultMark[res()].label} class="mt-0.5 shrink-0" />}
            </Show>
            <span class="min-w-0 flex-1">
              <span class={["", ticked().has(i()) ? "text-muted" : ""]}>{r().text}</span>
              <Show when={r().proof}>
                <span class="block text-xs text-muted">{r().proof}</span>
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
    <ol class="flex flex-col">
      <For each={props.milestones}>
        {(m) => (
          <li data-testid="milestone" data-kind={m.kind} class="flex gap-3 py-1 text-sm">
            <span class="w-16 shrink-0 text-muted">{wallClockText(m.at)}</span>
            <span
              class={[
                "min-w-0 flex-1 wrap-break-word",
                m.kind === "failed" || m.kind === "rejected" ? "text-berry" : "",
                m.kind === "asked" ? "font-semibold" : "",
              ]}
            >
              <Show when={m.who}>
                <span class="text-muted">{m.who} · </span>
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
    <Show when={runs().length > 0} fallback={<p class="text-xs text-faint">{t("web.issue.detail.noRuns")}</p>}>
      <div>
        <div class="mb-2 text-xs text-muted">{t("web.issue.detail.runCount", { n: runs().length })}</div>
        <For each={[...runs()].toReversed()}>
          {(r) => (
            <div class="flex gap-3 pb-2 text-sm">
              <span class="w-20 shrink-0 text-muted">{wallClockText(r.startedAt)}</span>
              <span class="min-w-0 flex-1">
                {runText(r, now(), tookText)}
                <Show when={r.summary}>
                  <span class="mt-0.5 line-clamp-2 block text-xs text-muted">{r.summary}</span>
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
    <ol class="max-h-105 overflow-y-auto font-mono text-xs">
      <For each={shown()}>
        {(e) => (
          <li class="flex gap-2.5 last:[border-bottom-style:solid] border-b last:border-b-0 border-line/60 py-1">
            <span class="w-14 shrink-0 text-faint">{wallClockText(e.time)}</span>
            <span class={["w-12 shrink-0", e.type === "run/error" ? "text-berry" : e.type === "tool/call" ? "text-water" : "text-muted"]}>
              {stepWord[e.type]}
            </span>
            <span class="line-clamp-3 min-w-0 flex-1 font-sans text-sm wrap-break-word whitespace-pre-wrap">
              {e.type === "tool/call" ? (e.actionText ?? e.text) : e.text}
            </span>
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
      <div class="flex items-start gap-3 pr-10">
        <h1 class="flex-1 text-xl font-semibold">{props.issue.title}</h1>
        <span class="mt-1.5 text-xs text-muted">{tagText(props.issue)}</span>
      </div>
      <div class="mt-3">
        <ActLines issue={props.issue.id} />
      </div>
      <Show when={props.issue.stage.acts.length > 0}>
        <div class="mt-3 flex flex-wrap items-center gap-2">
          <Show when={props.issue.stage.state === "stuck"}>
            <span class="text-sm text-berry">{t("web.issue.detail.orchestratorStuck")}</span>
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
      <div class="mt-4">
        <Property label={t("web.issue.detail.who")}>{t("web.issue.orchestrator")}</Property>
        <Show when={props.issue.description}>
          <Property label={t("web.issue.detail.job")}>
            <span class="text-base">{props.issue.description}</span>
          </Property>
        </Show>
        <Show when={props.issue.cron}>
          <Property label={t("web.issue.detail.from")}>{t("web.issue.detail.fromCron")}</Property>
        </Show>
        <Property label={t("web.issue.detail.opened")}>{wallClockText(props.issue.createdAt)}</Property>
        <Show when={props.issue.closedAt}>{(at) => <Property label={t("web.issue.detail.closedAt")}>{wallClockText(at())}</Property>}</Show>
        <Property label={t("web.issue.detail.answer")}>{t("web.issue.detail.answered")}</Property>
      </div>
      <h2 class="mt-5 mb-2 text-sm font-semibold">{t("web.issue.detail.runs")}</h2>
      <Runs issue={props.issue.id} version={`${props.issue.status}:${props.issue.closedAt}:${tagOpen(tag())}`} />
    </div>
  );
}

/** An answer issue's conclusion: the answer, what it rests on, what it is unsure of, what to do next. */
export function AnswerView(props: { answer: IssueAnswer }) {
  const list = (head: string, lines: readonly string[]) => (
    <Show when={lines.length > 0}>
      <div class="mt-2">
        <div class="text-xs text-muted">{head}</div>
        <For each={lines}>{(l) => <div class="text-sm">· {l}</div>}</For>
      </div>
    </Show>
  );
  return (
    <div>
      <p class="text-base">{props.answer.conclusion}</p>
      {list(t("web.issue.detail.evidence"), props.answer.evidence)}
      {list(t("web.issue.detail.unsure"), props.answer.unsure)}
      {list(t("web.issue.detail.next"), props.answer.next)}
    </div>
  );
}
