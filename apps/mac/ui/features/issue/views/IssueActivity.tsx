import { computed, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";
import type { ChatMessage, Issue, IssueTimeline, Milestone, Run } from "@vibevalley/protocol";
import { channelOf, plainText } from "@vibevalley/protocol/rules";

import { createAct } from "../../../design/act";
import { Button } from "../../../design/Button";
import { Icon } from "../../../design/Icon";
import { Banner } from "../../../design/layout";
import { Markdown } from "../../../design/Markdown";
import { motionClass } from "../../../design/motion";
import { CountPill, Dot } from "../../../design/Tag";
import { TextLink } from "../../../design/TextLink";
import { Bubble } from "../../../design/Tip";
import { api } from "../../../infra/api";
import { useNow } from "../../../infra/base/dom";
import { momentText, shortMomentText, tookText } from "../../../infra/base/format";
import { useCollabSlice } from "../../../infra/frame";
import { defineQuery, ready, retryRead, useQuery } from "../../../infra/query";
import { Link as A } from "../../../infra/router";
import { Attachments, Composer, followed, issueThreadOf, useFollowed } from "../../channel";
import { RunSteps, runsHref } from "../../session";
import { type ActivityItem, mergeIssueActivity, remainingMessageAttachments } from "../model/activity";
import { useIssueRuns, useIssueTimeline } from "../model/history";
import { localizeIssueError } from "../model/issueError";
import { ReconcileWorktree } from "./IssueSections";

const conversationQuery = defineQuery({
  key: (id: string) => ["issues", "conversation", id],
  fetch: (id, context) => api.issue.conversation.get({ id }, context),
  ...retryRead,
});

const milestoneTone = (kind: Milestone["kind"]) =>
  kind === "failed" || kind === "rejected" ? "berry" : kind === "asked" ? "wheat" : kind === "closed" || kind === "accepted" ? "leaf" : "muted";

function runMeta(run: Run, now: number): string {
  const parts = [tookText((run.endedAt ?? now) - run.startedAt)];
  if (run.spent?.cny !== undefined) parts.push(`¥${run.spent.cny.toFixed(2)}`);
  return parts.join(" · ");
}

function MilestoneRow(props: {
  item: Extract<ActivityItem, { kind: "milestone" }>;
  nextIsMilestone: boolean;
  isLast: boolean;
  headSessionId: string | undefined;
  now: number;
  onChanges?: (() => void) | undefined;
}) {
  const m = () => props.item.milestone;
  const saidInfo = computed(() => {
    const raw = m().said;
    return raw ? localizeIssueError(plainText(raw)) : undefined;
  });
  const stepsSession = computed(() => props.item.run?.session ?? props.headSessionId);
  const runId = computed(() => (props.item.attachRunSteps ? m().run : undefined));

  return (
    <View testID="milestone" class="flex-row items-stretch gap-3">
      <View class="w-3 shrink-0 items-center">
        <View class="mt-1.5">
          <Dot tone={milestoneTone(m().kind)} size={6} ring={false} />
        </View>
        <If when={props.nextIsMilestone}>
          <View class="mt-1 w-px flex-1 bg-line" />
        </If>
      </View>
      <View class={`min-w-0 flex-1 ${props.isLast ? "pb-0.5" : props.nextIsMilestone ? "pb-3" : "pb-2"}`}>
        <View class="flex-row flex-wrap items-baseline gap-2">
          <View tooltip={<Bubble text={momentText(m().at)} />} class="shrink-0">
            <Text class="text-xs text-faint tabular-nums">{shortMomentText(m().at, props.now)}</Text>
          </View>
          <If when={m().who}>
            <Text class="min-w-0 truncate text-xs font-medium text-muted">{m().who}</Text>
          </If>
          <If when={props.item.attachRunSteps ? props.item.run : undefined}>
            {(run) => <Text class="shrink-0 text-2xs text-faint tabular-nums">{runMeta(run(), props.now)}</Text>}
          </If>
        </View>
        <Text
          class={[
            "mt-0.5 text-sm leading-snug",
            m().kind === "failed" || m().kind === "rejected" ? "text-berry" : "text-ink",
            m().kind === "asked" ? "font-semibold" : "",
          ].join(" ")}
        >
          {localizeIssueError(plainText(m().text)).text}
        </Text>
        <If when={saidInfo()}>
          {(info) => (
            <View testID="milestone-said" class="mt-1 gap-1">
              <Text class="text-xs leading-relaxed text-muted">{info().text}</Text>
              <If when={info().settingsHref}>
                {(href) => (
                  <TextLink href={href()} testid="activity-error-settings">
                    {t("web.issue.error.goSettings")}
                  </TextLink>
                )}
              </If>
            </View>
          )}
        </If>
        <If when={props.item.attachRunSteps && props.item.run?.needsReconciliation === true}>
          <ReconcileWorktree onChanges={props.onChanges} />
        </If>
        <If when={stepsSession() && runId() ? ([stepsSession()!, runId()!] as const) : undefined}>
          {(target) => <RunSteps session={target()[0]} run={target()[1]} />}
        </If>
      </View>
    </View>
  );
}

function MessageRow(props: { message: ChatMessage; now: number }) {
  return (
    <View testID="issue-message" class="min-w-0 rounded-lg border border-line bg-page px-3.5 py-3">
      <View class="mb-1.5 flex-row items-center justify-between gap-2">
        <Text class="min-w-0 shrink truncate text-xs font-semibold text-ink">{props.message.name}</Text>
        <View tooltip={<Bubble text={momentText(props.message.at)} />} class="shrink-0">
          <Text class="text-2xs text-faint tabular-nums">{shortMomentText(props.message.at, props.now)}</Text>
        </View>
      </View>
      <If when={props.message.text.trim() !== "" || props.message.attachments.length === 0}>
        <View testID="issue-message-body" class="min-w-0">
          <Markdown size="sm" text={props.message.text} />
        </View>
      </If>
      <If when={remainingMessageAttachments(props.message)}>{(files) => <Attachments files={files()} />}</If>
    </View>
  );
}

const asMilestone = (entry: ActivityItem) => (entry.kind === "milestone" ? entry : undefined);
const asMessage = (entry: ActivityItem) => (entry.kind === "message" ? entry : undefined);

/** Unified chronological activity stream merging milestones, discussion comments, and expandable per-run steps. */
export function IssueActivity(props: {
  issue: Issue;
  headSessionId?: string | undefined;
  timeline?: IssueTimeline | undefined;
  timelinePending?: boolean | undefined;
  rounds?: number | undefined;
  runsVersion?: string | undefined;
  onChanges?: (() => void) | undefined;
}) {
  const collab = useCollabSlice();
  const now = useNow();
  const act = createAct();

  const ownTimelineQuery = useIssueTimeline(
    () => props.issue,
    () => props.rounds ?? (props.issue.refining ? 1 : 0),
    () => props.timeline === undefined,
  );
  const timeline = computed(() => props.timeline ?? ready(ownTimelineQuery, undefined));
  const runsVersion = computed(
    () => props.runsVersion ?? `${props.issue.stage.state}:${props.issue.refining?.session ?? ""}:${props.issue.findings.length}:${props.issue.closedAt ?? ""}`,
  );
  const runsQuery = useIssueRuns(() => props.issue.id, runsVersion);
  const runs = computed(() => ready(runsQuery, []));

  const location = useQuery(() => conversationQuery(props.issue.id));
  const threadChannel = computed(() => issueThreadOf(collab()?.chat, props.issue.id) ?? channelOf(collab()?.chat, ready(location, undefined) ?? undefined));
  const thread = computed(() => threadChannel()?.id ?? ready(location, undefined) ?? undefined);
  const feed = useFollowed(thread);

  const items = computed(() => mergeIssueActivity(timeline()?.milestones ?? [], feed().messages, runs()));
  const timelineLoading = computed(() => (props.timeline === undefined ? ownTimelineQuery.status() === "pending" : props.timelinePending === true));

  return (
    <View testID="issue-activity" accessibilityLabel={t("web.issue.activity.title")} class="mt-7 border-t border-line pt-5">
      <View class="mb-2.5 flex-row items-center justify-between gap-2">
        <View class="flex-row items-center gap-2">
          <Text class="text-xs font-semibold text-muted">{t("web.issue.activity.title")}</Text>
          <If when={items().length > 0}>
            <CountPill count={items().length} />
          </If>
        </View>
        <If when={props.headSessionId}>
          {(sessionId) => (
            <A
              href={runsHref({ session: sessionId(), issue: props.issue.id })}
              testID="issue-open-trajectory"
              class={`h-6 shrink-0 flex-row items-center gap-1 rounded-md px-2 ${motionClass("transition-transform duration-120 ease-out")} hover:bg-hover active:translate-y-px`}
            >
              <Icon name="log" size={12} tone="muted" />
              <Text class="text-xs font-medium text-muted">{t("web.issue.detail.openTrajectory")}</Text>
            </A>
          )}
        </If>
      </View>
      <If when={feed().error}>{(error) => <Banner class="mb-3">{error()}</Banner>}</If>
      <If when={thread() && feed().ready && !feed().complete}>
        <Button
          tone="quiet"
          icon="clock"
          class="mb-3 self-start"
          disabled={act.busy()}
          onPress={() => {
            const id = thread();
            if (id) void act.run(() => followed.loadOlder(id));
          }}
        >
          {t("web.issue.conversation.older")}
        </Button>
      </If>
      <If
        when={items().length > 0}
        else={
          <View class="flex-row items-center gap-2 rounded-lg border border-line bg-side px-3.5 py-2.5">
            <Icon name="chat" size={14} tone="faint" />
            <Text class="min-w-0 flex-1 text-xs text-muted">{timelineLoading() ? t("web.issue.reading") : t("web.issue.activity.empty")}</Text>
          </View>
        }
      >
        <View class="gap-2">
          <Each of={items()} key={(entry) => entry.key}>
            {(entry, i) => (
              <If when={asMilestone(entry())} else={<If when={asMessage(entry())}>{(msg) => <MessageRow message={msg().message} now={now()} />}</If>}>
                {(ms) => (
                  <MilestoneRow
                    item={ms()}
                    nextIsMilestone={items()[i() + 1]?.kind === "milestone"}
                    isLast={i() === items().length - 1}
                    headSessionId={props.headSessionId}
                    now={now()}
                    onChanges={props.onChanges}
                  />
                )}
              </If>
            )}
          </Each>
        </View>
      </If>
      <If when={threadChannel()}>
        {(ch) => (
          <View testID="issue-comment-composer" class="mt-3 rounded-lg border-r border-b border-l border-line bg-side">
            <Composer channel={ch()} placeholder={t("web.issue.conversation.placeholder")} />
          </View>
        )}
      </If>
    </View>
  );
}
