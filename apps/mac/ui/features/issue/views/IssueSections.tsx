import { Clipboard, computed, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Attachment, DeliveryReceipt, Issue, IssueAction, IssueAnswer, Question as QuestionItem } from "@vibevalley/protocol";

import { Button } from "../../../design/Button";
import { Checkbox } from "../../../design/Checkbox";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import type { IconName } from "../../../design/icons";
import { Markdown } from "../../../design/Markdown";
import { Tag, type TagTone } from "../../../design/Tag";
import { TextLink } from "../../../design/TextLink";
import { toast } from "../../../design/toasts";
import { mix } from "../../../design/tone";
import { createAct } from "../../../infra/act";
import { useNow } from "../../../infra/base/dom";
import { shortMomentText, tookText } from "../../../infra/base/format";
import { hostApi } from "../../../infra/bridge";
import { perform } from "../../../infra/issueActions";
import { ready } from "../../../infra/query";
import { Link as A } from "../../../infra/router";
import { useIntents } from "../../../infra/state/intent";
import { SubagentProgress } from "../../session";
import { useIssueRuns } from "../model/history";
import { issueTag, runText, tagOpen, tagText } from "../model/issue";
import { localizeIssueError } from "../model/issueError";
import { issueMove, issueMoveOf, sendMove } from "../model/moves";
import { type CriterionRow, stageTone } from "../model/overview";
import { updateIssueAttachments } from "../model/write";
import { ActLines } from "./ActLines";
import { IssueAttachments } from "./IssueAttachments";
import { StatusMark } from "./Marks";
import { IssueSheet, Note, Property, SheetLabel, StagePill } from "./Sheet";

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
    <View class="overflow-hidden rounded-lg border border-line bg-page">
      <Each of={props.rows} key={(r) => r.text}>
        {(r, i) => (
          <View
            testID="criterion"
            class={`flex-row items-start gap-2.5 px-3.5 py-2.5 ${i() < props.rows.length - 1 ? "border-b" : ""}`}
            style={i() < props.rows.length - 1 ? { borderColor: mix("line", 0.55) } : undefined}
          >
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
              else={
                <View
                  testID="criterion-unsaid"
                  accessibilityLabel={t("web.issue.detail.unsaid")}
                  class="mt-1 h-3 w-3 shrink-0 rounded-full border border-idle"
                />
              }
            >
              {(res) => (
                <View class="mt-0.5 shrink-0">
                  <Icon name={resultMark[res()].icon} size={14} label={resultMark[res()].label} />
                </View>
              )}
            </If>
            <View class="min-w-0 flex-1">
              <Text class={`text-sm leading-snug ${ticked().has(i()) ? "text-muted" : "text-ink"}`}>{r().text}</Text>
              <If when={r().proof}>
                <Text class="mt-0.5 text-xs text-muted">{r().proof}</Text>
              </If>
            </View>
          </View>
        )}
      </Each>
    </View>
  );
}

function receiptKindMeta(kind: DeliveryReceipt["kind"]): { readonly icon: IconName; readonly tone: TagTone; readonly label: string } {
  switch (kind) {
    case "pull_request":
      return { icon: "branch", tone: "info", label: t("web.issue.receipt.kinds.pull_request") };
    case "commit":
      return { icon: "diff", tone: "ok", label: t("web.issue.receipt.kinds.commit") };
    case "note":
      return { icon: "notes", tone: "wait", label: t("web.issue.receipt.kinds.note") };
    case "answer":
      return { icon: "chat", tone: "neutral", label: t("web.issue.receipt.kinds.answer") };
  }
}

/** Renders a polymorphic `DeliveryReceipt` (`pull_request`, `commit`, `note`, or `answer`). */
export function DeliveryReceiptCard(props: { receipt: DeliveryReceipt; class?: string }) {
  const meta = computed(() => receiptKindMeta(props.receipt.kind));
  const copySha = (sha: string) => {
    void Clipboard.writeText(sha).then(
      () => toast(t("web.base.rich.copied")),
      () => undefined,
    );
  };
  return (
    <View testID="delivery-receipt" class={`gap-2 rounded-lg border border-line bg-page p-3.5 ${props.class ?? ""}`}>
      <View class="flex-row flex-wrap items-center justify-between gap-2">
        <View class="flex-row items-center gap-2">
          <Text class="text-xs font-semibold text-muted">{t("web.issue.receipt.title")}</Text>
          <Tag icon={meta().icon} tone={meta().tone} label={meta().label} />
        </View>
        <If when={props.receipt.kind === "pull_request" && props.receipt.branch ? props.receipt.branch : undefined}>
          {(branch) => (
            <View class="rounded-sm bg-side px-1.5 py-0.5">
              <Text class="font-mono text-2xs text-muted">{branch()}</Text>
            </View>
          )}
        </If>
        <If when={props.receipt.kind === "commit" && props.receipt.branch ? props.receipt.branch : undefined}>
          {(branch) => (
            <View class="rounded-sm bg-side px-1.5 py-0.5">
              <Text class="font-mono text-2xs text-muted">{branch()}</Text>
            </View>
          )}
        </If>
      </View>

      <If when={props.receipt.kind === "pull_request" ? props.receipt : undefined}>
        {(pr) => (
          <View class="gap-1.5">
            <View
              role="link"
              testID="delivery-receipt-pr-link"
              onPress={() => void hostApi.openUrl(pr().url)}
              class="flex-row items-center gap-1.5 self-start rounded-md border border-line bg-side px-2.5 py-1 hover:bg-hover"
            >
              <Icon name="branch" size={12} tone="water" />
              <Text class="text-xs font-medium text-water">{pr().number !== undefined ? `PR #${pr().number}` : t("web.issue.receipt.openPr")}</Text>
              <Text class="max-w-72 truncate font-mono text-2xs text-muted">{pr().url}</Text>
            </View>
            <If when={pr().summary}>{(summary) => <Text class="text-sm leading-relaxed text-ink">{summary()}</Text>}</If>
          </View>
        )}
      </If>

      <If when={props.receipt.kind === "commit" ? props.receipt : undefined}>
        {(commit) => (
          <View class="gap-1.5">
            <View class="flex-row items-center gap-1.5">
              <View class="rounded-sm bg-side px-2 py-0.5">
                <Text testID="delivery-receipt-commit-sha" class="font-mono text-xs font-medium text-ink">
                  {commit().sha.slice(0, 12)}
                </Text>
              </View>
              <IconButton icon="copy" size={14} label={t("web.base.rich.copy")} onClick={() => copySha(commit().sha)} />
            </View>
            <If when={commit().summary}>{(summary) => <Text class="text-sm leading-relaxed text-ink">{summary()}</Text>}</If>
          </View>
        )}
      </If>

      <If when={props.receipt.kind === "note" ? props.receipt : undefined}>
        {(note) => (
          <View class="gap-1.5">
            <A
              href={`/notes/${encodeURIComponent(note().noteId)}`}
              testID="delivery-receipt-note-link"
              class="flex-row items-center gap-1.5 self-start rounded-md border border-line bg-side px-2.5 py-1 hover:bg-hover"
            >
              <Icon name="notes" size={12} tone="water" />
              <Text class="text-xs font-medium text-water">{note().title || note().noteId}</Text>
              <Text class="text-2xs text-muted">{t("web.issue.receipt.openNote")}</Text>
            </A>
            <If when={note().summary}>{(summary) => <Text class="text-sm leading-relaxed text-ink">{summary()}</Text>}</If>
          </View>
        )}
      </If>

      <If when={props.receipt.kind === "answer" ? props.receipt : undefined}>
        {(ans) => (
          <View testID="delivery-receipt-answer" class="min-w-0">
            <Markdown size="sm" text={ans().summary} />
          </View>
        )}
      </If>
    </View>
  );
}

function Runs(props: { issue: string; version: string }) {
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
                  {(summary) => (
                    <View class="mt-0.5 gap-1">
                      <Text class="line-clamp-2 text-xs text-muted">{localizeIssueError(summary()).text}</Text>
                      <If when={localizeIssueError(summary()).settingsHref}>
                        {(href) => (
                          <TextLink href={href()} testid="run-error-settings">
                            {t("web.issue.error.goSettings")}
                          </TextLink>
                        )}
                      </If>
                    </View>
                  )}
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
      <View class="mb-2 flex-row flex-wrap items-center gap-1.5">
        <View class="flex-row items-center gap-1 rounded-md bg-side px-1.5 py-0.5">
          <Icon name="agents" size={12} tone="muted" />
          <Text class="text-xs font-medium text-muted">{t("web.issue.orchestrator")}</Text>
        </View>
      </View>
      <Text role="header" class="text-2xl leading-snug font-semibold text-ink">
        {props.issue.title}
      </Text>
      <View class="mt-2.5 flex-row flex-wrap items-center gap-2">
        <StagePill tone={tone()} label={tagText(props.issue)} />
      </View>
    </View>
  );

  const hasAboveRuns = computed(() => Boolean(props.issue.description || props.issue.stage.state === "stuck" || hasAttachmentsSection()));
  const main = (
    <>
      <ActLines issue={props.issue.id} />
      <If when={props.issue.stage.state === "stuck"}>
        <Note tone="berry" class="mb-5">
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
      <If when={props.issue.deliveryReceipt}>
        {(receipt) => (
          <View class="mt-4">
            <DeliveryReceiptCard receipt={receipt()} />
          </View>
        )}
      </If>
      <View class={hasAboveRuns() || Boolean(props.issue.deliveryReceipt) ? "mt-7 border-t border-line pt-5" : ""}>
        <SheetLabel first>{t("web.issue.detail.runs")}</SheetLabel>
        <Runs issue={props.issue.id} version={`${props.issue.status}:${props.issue.closedAt}:${tagOpen(tag())}`} />
      </View>
    </>
  );

  const side = (
    <>
      <SheetLabel first>{t("web.issue.detail.properties")}</SheetLabel>
      <Property label={t("web.issue.detail.status")} icon={<StatusMark status={props.issue.status} size={13} />}>
        {tagText(props.issue)}
      </Property>
      <Property label={t("web.issue.detail.who")} icon={<Icon name="agents" size={13} tone="muted" />}>
        {t("web.issue.orchestrator")}
      </Property>
      <If when={props.issue.cron}>
        <Property align="start" label={t("web.issue.detail.from")} icon={<Icon name="clock" size={13} tone="muted" />}>
          {t("web.issue.detail.fromCron")}
        </Property>
      </If>
      <Property label={t("web.issue.detail.answer")} icon={<Icon name="chat" size={13} tone="muted" />}>
        {t("web.issue.detail.answered")}
      </Property>
      <SheetLabel divider>{t("web.issue.detail.time")}</SheetLabel>
      <Property label={t("web.issue.detail.opened")} icon={<Icon name="clock" size={13} tone="muted" />}>
        <Text class="text-sm text-ink tabular-nums">{shortMomentText(props.issue.createdAt, now())}</Text>
      </Property>
      <If when={props.issue.closedAt}>
        {(at) => (
          <Property label={t("web.issue.detail.closedAt")} icon={<Icon name="clock" size={13} tone="muted" />}>
            <Text class="text-sm text-ink tabular-nums">{shortMomentText(at(), now())}</Text>
          </Property>
        )}
      </If>
      <If when={props.issue.stage.acts.length > 0}>
        <View class="mt-4 flex-row flex-wrap items-center gap-2 border-t border-line pt-4">
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
