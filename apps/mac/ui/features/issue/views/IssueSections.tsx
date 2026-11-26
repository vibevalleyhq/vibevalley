import { computed, Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Attachment, Issue, IssueAction, IssueAnswer, Milestone, Question as QuestionItem, SessionEvent } from "@vibevalley/protocol";
import { plainText } from "@vibevalley/protocol/rules";

import { createAct } from "../../../design/act";
import { Button } from "../../../design/Button";
import { Checkbox } from "../../../design/Checkbox";
import { Icon } from "../../../design/Icon";
import type { IconName } from "../../../design/icons";
import { Markdown } from "../../../design/Markdown";
import { Dot } from "../../../design/Tag";
import { mix } from "../../../design/tone";
import { useNow } from "../../../infra/base/dom";
import { shortMomentText, tookText, wallClockText } from "../../../infra/base/format";
import { ready } from "../../../infra/query";
import { useIntents } from "../../../infra/state/intent";
import { SubagentProgress } from "../../session";
import { perform } from "../model/acts";
import { useIssueRuns } from "../model/history";
import { issueTag, runText, tagOpen, tagText } from "../model/issue";
import { issueMove, issueMoveOf, sendMove } from "../model/moves";
import { type CriterionRow, stageTone } from "../model/overview";
import { updateIssueAttachments } from "../model/write";
import { ActLines } from "./ActLines";
import { IssueAttachments } from "./IssueAttachments";
import { IssueNumberPill, IssueSheet, Note, Property, SheetLabel } from "./Sheet";

/** A question of the helper's: its options are replies as they are, one click each. */
export function Question(props: { ask: QuestionItem; busy: boolean; onPick: (words: string) => void }) {
  return (
    <View class="mt-2.5">
      <Text class="text-sm text-ink">{props.ask.question}</Text>
      <If when={props.ask.options.length}>
        <View class="mt-1.5 flex-row flex-wrap gap-1.5" accessibilityLabel={t("web.issue.detail.answerTo", { question: props.ask.question })}>
          <Each of={props.ask.options} key={(o) => o}>
            {(o) => (
              <Button testID="answer-option" disabled={props.busy} onPress={() => props.onPick(o())}>
                {o()}
              </Button>
            )}
          </Each>
        </View>
      </If>
    </View>
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
  const ticked = signal<ReadonlySet<number>>(new Set());
  const tick = (i: number) => {
    const n = new Set(ticked());
    if (n.has(i)) n.delete(i);
    else n.add(i);
    ticked.set(n);
  };
  return (
    <View>
      <Each of={props.rows} key={(r) => r.text}>
        {(r, i) => (
          <View testID="criterion" class="flex-row items-start gap-2.5 rounded-md px-1.5 py-1">
            <If when={props.checking}>
              <Checkbox
                testid="criterion-tick"
                label={t("web.issue.detail.ticked", { criterion: r().text })}
                checked={ticked().has(i())}
                onChange={() => tick(i())}
                class="mt-0.5"
              />
            </If>
            <If
              when={r().result}
              else={<View accessibilityLabel={t("web.issue.detail.unsaid")} class="mt-1 h-3 w-3 shrink-0 rounded-full border border-line" />}
            >
              {(res) => (
                <View class="mt-0.5 shrink-0">
                  <Icon name={resultMark[res()].icon} size={14} label={resultMark[res()].label} />
                </View>
              )}
            </If>
            <View class="min-w-0 flex-1">
              <Text class={`text-sm ${ticked().has(i()) ? "text-muted" : "text-ink"}`}>{r().text}</Text>
              <If when={r().proof}>
                <Text class="text-xs text-muted">{r().proof}</Text>
              </If>
            </View>
          </View>
        )}
      </Each>
    </View>
  );
}

/** The milestones, newest first: when, who, what. */
export function Story(props: { milestones: Milestone[] }) {
  const now = useNow();
  return (
    <View>
      <Each of={props.milestones} key={(m) => `${m.at}:${m.kind}:${m.text}`}>
        {(m) => (
          <View testID="milestone" class="flex-row items-baseline gap-3 py-1">
            <Text class="w-24 shrink-0 text-xs text-muted tabular-nums">{shortMomentText(m().at, now())}</Text>
            <Text
              class={[
                "min-w-0 flex-1 text-sm",
                m().kind === "failed" || m().kind === "rejected" ? "text-berry" : "text-ink",
                m().kind === "asked" ? "font-semibold" : "",
              ].join(" ")}
            >
              <If when={m().who}>
                <Text class="text-muted">{`${m().who} · `}</Text>
              </If>
              {plainText(m().text)}
            </Text>
          </View>
        )}
      </Each>
    </View>
  );
}

export function ReconcileWorktree(props: { onChanges?: (() => void) | undefined }) {
  return (
    <View testID="run-reconcile" class="my-1.5 flex-row flex-wrap items-center gap-2">
      <Icon name="warn" size={14} tone="berry" />
      <Text class="text-sm text-ink">{t("web.issue.run.reconcile")}</Text>
      <If when={props.onChanges}>
        {(show) => (
          <Button testID="run-review-changes" onPress={() => show()()}>
            {t("web.issue.run.currentChanges")}
          </Button>
        )}
      </If>
    </View>
  );
}

export function Runs(props: { issue: string; version: string; onChanges?: (() => void) | undefined }) {
  const query = useIssueRuns(
    () => props.issue,
    () => props.version,
  );
  const runs = computed(() => ready(query, []));
  const reversedRuns = computed(() => runs().toReversed());
  const now = useNow();
  return (
    <If when={runs().length > 0} else={<Text class="text-xs text-faint">{t("web.issue.detail.noRuns")}</Text>}>
      <View>
        <Text class="mb-2 text-xs text-muted tabular-nums">{t("web.issue.detail.runCount", { n: runs().length })}</Text>
        <Each of={reversedRuns()} key={(run) => run.id}>
          {(r) => (
            <View class="flex-row items-baseline gap-3 pb-2">
              <Text class="w-24 shrink-0 text-xs text-muted tabular-nums">{shortMomentText(r().startedAt, now())}</Text>
              <View class="min-w-0 flex-1">
                <Text class="text-sm text-ink">{runText(r(), now(), tookText)}</Text>
                <If when={r().summary}>
                  <Text class="mt-0.5 line-clamp-2 text-xs text-muted">{r().summary}</Text>
                </If>
                <If when={r().needsReconciliation}>
                  <ReconcileWorktree onChanges={props.onChanges} />
                </If>
                <If when={r().subagents}>{(progress) => <SubagentProgress session={r().session} progress={progress()} now={now()} />}</If>
              </View>
            </View>
          )}
        </Each>
      </View>
    </If>
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
  const shown = computed(() => props.steps.filter((e) => stepWord[e.type] !== undefined).slice(-240));
  return (
    <Scroll testID="issue-steps" class="max-h-[420px]">
      <Each of={shown()} key={(e) => e.seq}>
        {(e, i) => (
          <View class={`flex-row gap-2.5 py-1 ${i() < shown().length - 1 ? "border-b" : ""}`} style={{ borderColor: mix("line", 0.6) }}>
            <Text class="w-14 shrink-0 font-mono text-xs text-faint tabular-nums">{wallClockText(e().time)}</Text>
            <Text class={`w-12 shrink-0 font-mono text-xs ${e().type === "run/error" ? "text-berry" : e().type === "tool/call" ? "text-water" : "text-muted"}`}>
              {stepWord[e().type] ?? ""}
            </Text>
            <Text class="line-clamp-3 min-w-0 flex-1 text-sm text-ink">{e().type === "tool/call" ? (e().actionText ?? e().text) : e().text}</Text>
          </View>
        )}
      </Each>
    </Scroll>
  );
}

/** An issue for the orchestrator: what it was asked, and its runs; the answers are in its channel. */
export function OrchestratorIssueDetail(props: { issue: Issue }) {
  const tag = computed(() => issueTag(props.issue));
  const now = useNow();
  const act = createAct();
  const moves = useIntents(issueMove);
  const move = computed(() => issueMoveOf(props.issue.id, moves.list()));
  const busy = computed(() => act.busy() || move()?.state === "moving");
  const tone = computed(() => stageTone[props.issue.stage.state]);
  const open = computed(() => props.issue.status !== "done" && props.issue.status !== "canceled");
  const attachAct = createAct();
  const hasAttachmentsSection = computed(() => open() || (props.issue.attachments?.length ?? 0) > 0);
  const addAttachment = (file: Attachment) => {
    const current = (props.issue.attachments ?? []).map((a) => a.id);
    if (current.includes(file.id)) return;
    return attachAct.run(() => updateIssueAttachments(props.issue.id, [...current, file.id]));
  };
  const removeAttachment = (id: string) => {
    const next = (props.issue.attachments ?? []).filter((a) => a.id !== id).map((a) => a.id);
    return attachAct.run(() => updateIssueAttachments(props.issue.id, next));
  };
  // The orchestrator's answer is the user's to take as done or put away; one that did not end well can only be put away.
  const go = (a: IssueAction) => {
    const issue = props.issue;
    if (a.does === "move") void sendMove(moves, { id: issue.id, status: a.status });
    else void act.run(() => perform(issue, a));
  };

  const heading = (
    <View>
      <View class="mb-1.5 flex-row flex-wrap items-center gap-1">
        <Text class="text-xs text-muted">{t("web.issue.orchestrator")}</Text>
        <Icon name="next" size={12} tone="muted" />
        <IssueNumberPill number={props.issue.number} />
      </View>
      <Text role="header" class="text-lg font-semibold text-ink">
        {props.issue.title}
      </Text>
      <View class="mt-2 flex-row items-center gap-2">
        <Dot tone={tone()} size={8} ring={false} />
        <Text class="text-sm text-muted">{tagText(props.issue)}</Text>
      </View>
    </View>
  );

  const main = (
    <>
      <ActLines issue={props.issue.id} />
      <If when={props.issue.stage.state === "stuck"}>
        <Note tone="berry" class="mb-4">
          <Text class="text-sm text-ink">{t("web.issue.detail.orchestratorStuck")}</Text>
        </Note>
      </If>
      <If when={props.issue.description}>
        <View>
          <SheetLabel first={props.issue.stage.state !== "stuck"}>{t("web.issue.detail.job")}</SheetLabel>
          <Markdown size="sm" text={props.issue.description} />
        </View>
      </If>
      <IssueAttachments
        files={props.issue.attachments ?? []}
        editable={open()}
        busy={attachAct.busy()}
        first={!props.issue.description && props.issue.stage.state !== "stuck"}
        onAdd={addAttachment}
        onRemove={removeAttachment}
      />
      <View>
        <SheetLabel first={!props.issue.description && props.issue.stage.state !== "stuck" && !hasAttachmentsSection()}>
          {t("web.issue.detail.runs")}
        </SheetLabel>
        <Runs issue={props.issue.id} version={`${props.issue.status}:${props.issue.closedAt}:${tagOpen(tag())}`} />
      </View>
    </>
  );

  const side = (
    <>
      <SheetLabel first>{t("web.issue.detail.properties")}</SheetLabel>
      <Property label={t("web.issue.detail.status")}>
        <View class="flex-row items-center gap-2">
          <Dot tone={tone()} size={8} ring={false} />
          <Text class="text-sm text-ink">{tagText(props.issue)}</Text>
        </View>
      </Property>
      <Property label={t("web.issue.detail.who")}>{t("web.issue.orchestrator")}</Property>
      <If when={props.issue.cron}>
        <Property align="start" label={t("web.issue.detail.from")}>
          {t("web.issue.detail.fromCron")}
        </Property>
      </If>
      <Property label={t("web.issue.detail.answer")}>{t("web.issue.detail.answered")}</Property>
      <If when={props.issue.stage.acts.length > 0}>
        <View class="mt-3 flex-row flex-wrap gap-2">
          <Each of={props.issue.stage.acts} key={(a) => a.act}>
            {(a) => (
              <Button
                tone={a().act === props.issue.stage.lead ? "primary" : a().act === "close" ? "danger" : "plain"}
                disabled={busy()}
                onPress={() => go(a())}
              >
                {t(`shared.act.${a().act}`)}
              </Button>
            )}
          </Each>
        </View>
      </If>
      <SheetLabel divider>{t("web.issue.detail.time")}</SheetLabel>
      <Property label={t("web.issue.detail.opened")}>
        <Text class="text-sm text-ink tabular-nums">{shortMomentText(props.issue.createdAt, now())}</Text>
      </Property>
      <If when={props.issue.closedAt}>
        {(at) => (
          <Property label={t("web.issue.detail.closedAt")}>
            <Text class="text-sm text-ink tabular-nums">{shortMomentText(at(), now())}</Text>
          </Property>
        )}
      </If>
    </>
  );

  return (
    <View testID="issue-orchestrator" class="min-h-0 flex-1">
      <IssueSheet heading={heading} main={main} side={side} />
    </View>
  );
}

/** An answer issue's conclusion: the answer, what it rests on, what it is unsure of, what to do next. */
export function AnswerView(props: { answer: IssueAnswer }) {
  const list = (head: string, lines: readonly string[]) => (
    <If when={lines.length > 0}>
      <View class="mt-2">
        <Text class="text-xs text-muted">{head}</Text>
        <Each of={lines} key="index">
          {(l) => <Text class="text-sm text-ink">{`· ${l()}`}</Text>}
        </Each>
      </View>
    </If>
  );
  return (
    <View testID="issue-answer">
      <Text class="text-base text-ink">{props.answer.conclusion}</Text>
      {list(t("web.issue.detail.evidence"), props.answer.evidence)}
      {list(t("web.issue.detail.unsure"), props.answer.unsure)}
      {list(t("web.issue.detail.next"), props.answer.next)}
    </View>
  );
}
