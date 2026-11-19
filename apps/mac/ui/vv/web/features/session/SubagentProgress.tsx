import { Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { createMemo } from "../../../solid";
import { ago } from "../../base/format";
import { Icon } from "../../ui/Icon";
import { Dot, type DotTone } from "../../ui/Tag";
import { createSessionEvents } from "./events";
import { shownEvents } from "./runs";
import { describeSubagents, type SubagentSummary } from "./subagents";
import { WorkLogStep } from "./WorkLog";

type Thread = SubagentSummary["threads"][number];

const tones = {
  pendingInit: "wheat",
  running: "water",
  interrupted: "wheat",
  completed: "leaf",
  errored: "berry",
  shutdown: "muted",
  notFound: "muted",
  unknown: "muted",
} satisfies Record<NonNullable<Thread["status"]> | "unknown", DotTone>;

const lastActivity = (thread: Thread) => thread.lastActivity || (thread.lastAction ? t(`shared.action.${thread.lastAction}`) : undefined);

export function SubagentProgress(props: { session: string; progress: SubagentSummary; now: number }) {
  const picked = signal<{ session: string; run: string; thread: string }>();
  const selected = (id: string) => picked()?.session === props.session && picked()?.run === props.progress.run && picked()?.thread === id;
  const labels = createMemo(() => describeSubagents(props.progress));
  return (
    <View testID="subagent-progress" class="my-2 gap-1.5">
      <Text role="header" class="text-sm font-semibold text-ink">
        {t("web.session.subagents.heading")}
      </Text>
      <If when={props.progress.disconnectedAt}>
        {(at) => (
          <Text testID="subagent-disconnected" class="text-sm text-muted">
            {t("web.session.subagents.disconnected", { ago: ago(at(), props.now) })}
          </Text>
        )}
      </If>
      <Each of={labels().waits} key={(wait) => wait.key}>
        {(wait) => (
          <Text testID="subagent-wait" class="text-sm text-water">
            {wait().text}
          </Text>
        )}
      </Each>
      <Each of={props.progress.threads} key={(thread) => thread.threadId}>
        {(thread) => (
          <View class="rounded-md border border-line">
            <View
              role="button"
              testID={`subagent-${thread().threadId}`}
              accessibilityLabel={t("web.session.subagents.openLog", { task: labels().name(thread().threadId) })}
              accessibilityState={{ expanded: selected(thread().threadId) }}
              class="gap-1 rounded-md px-2.5 py-2 hover:bg-hover"
              onPress={() =>
                picked.set(selected(thread().threadId) ? undefined : { session: props.session, run: props.progress.run, thread: thread().threadId })
              }
            >
              <View class="flex-row items-center gap-2">
                <Dot tone={tones[thread().status ?? "unknown"]} size={7} ring={false} />
                <Text class="min-w-0 flex-1 text-sm font-medium text-ink">{labels().name(thread().threadId)}</Text>
                <Icon name={selected(thread().threadId) ? "collapse" : "expand"} size={12} tone="muted" />
              </View>
              <Text class="text-xs text-muted">
                {t("web.session.subagents.observed", {
                  status: t(`web.session.subagents.status.${thread().status ?? "unknown"}`),
                  ago: ago(thread().updatedAt, props.now),
                })}
              </Text>
              <If when={lastActivity(thread())}>
                {(activity) => (
                  <Text class="text-xs text-ink" style={{ numberOfLines: 3 }}>
                    {activity()}
                  </Text>
                )}
              </If>
              <If when={thread().parentThreadId}>
                {(parent) => <Text class="text-xs text-muted">{t("web.session.subagents.creator", { who: labels().name(parent()) })}</Text>}
              </If>
            </View>
            <If when={selected(thread().threadId)}>
              <View class="border-t border-line p-2">
                <If when={thread().steps?.length}>
                  <View testID="subagent-steps" class="mb-2 gap-1">
                    <Text class="text-xs font-semibold text-muted">{t("web.session.subagents.steps.title")}</Text>
                    <Each of={thread().steps ?? []}>
                      {(item) => (
                        <View class="flex-row items-start gap-2">
                          <Text class="shrink-0 text-xs text-muted">{t(`web.session.subagents.steps.${item().status}`)}</Text>
                          <Text class="min-w-0 flex-1 text-sm text-ink">{item().step}</Text>
                        </View>
                      )}
                    </Each>
                  </View>
                </If>
                <ThreadLog session={props.session} run={props.progress.run} thread={thread().threadId} now={props.now} />
              </View>
            </If>
          </View>
        )}
      </Each>
    </View>
  );
}

function ThreadLog(props: { session: string; run: string; thread: string; now: number }) {
  const steps = createSessionEvents(
    () => props.session,
    () => true,
  );
  const log = createMemo(() => shownEvents(steps().filter((step) => step.run === props.run && step.threadId === props.thread)));
  return (
    <View testID="subagent-log">
      <If when={log().length > 0} else={<Text class="text-xs text-muted">{t("web.session.subagents.noLog")}</Text>}>
        <Scroll style={{ maxHeight: 352 }} accessibilityLabel={t("web.session.log.process")}>
          <Each of={log()} key={(step) => step.seq}>
            {(step) => <WorkLogStep step={step()} now={props.now} />}
          </Each>
        </Scroll>
      </If>
    </View>
  );
}
