import { Scroll, signal, Text, View } from "nsh";

import { t } from "@vibevalley/i18n";

import { Icon } from "../../design/Icon";
import { Banner } from "../../design/layout";
import { motionClass } from "../../design/motion";
import { CountPill, Dot, type DotTone } from "../../design/Tag";
import { Bubble } from "../../design/Tip";
import { mix } from "../../design/tone";
import { ago } from "../../infra/base/format";
import { createMemo } from "../../infra/solid";
import { createSessionEvents } from "./events";
import { shownEvents } from "./runs";
import { describeSubagents, type SubagentSummary } from "./subagents";
import { WorkLogStep } from "./WorkLog";

type Thread = SubagentSummary["threads"][number];
type ThreadStatus = NonNullable<Thread["status"]> | "unknown";
type StepStatus = NonNullable<Thread["steps"]>[number]["status"];

interface StatusMeta {
  readonly dot: DotTone;
  readonly glyph: "check" | "cross" | "warn" | "dot";
  readonly pillClass: string;
  readonly pillBg?: () => string;
  readonly pillText: string;
}

const statusMeta: Record<ThreadStatus, StatusMeta> = {
  pendingInit: { dot: "wheat", glyph: "dot", pillClass: "bg-warn-soft", pillText: "text-warn-ink" },
  running: { dot: "water", glyph: "dot", pillClass: "", pillBg: () => mix("water", 0.14), pillText: "text-water" },
  interrupted: { dot: "wheat", glyph: "warn", pillClass: "bg-warn-soft", pillText: "text-warn-ink" },
  completed: { dot: "leaf", glyph: "check", pillClass: "bg-ok-soft", pillText: "text-ok-ink" },
  errored: { dot: "berry", glyph: "cross", pillClass: "bg-bad-soft", pillText: "text-berry" },
  shutdown: { dot: "muted", glyph: "dot", pillClass: "bg-hover", pillText: "text-muted" },
  notFound: { dot: "muted", glyph: "dot", pillClass: "bg-hover", pillText: "text-muted" },
  unknown: { dot: "muted", glyph: "dot", pillClass: "bg-hover", pillText: "text-muted" },
};

const stepStatusText: Record<StepStatus, string> = {
  pending: "text-faint",
  inProgress: "text-water",
  completed: "text-ok-ink",
};

const lastActivity = (thread: Thread) => thread.lastActivity || (thread.lastAction ? t(`shared.action.${thread.lastAction}`) : undefined);

function StatusGlyph(props: { status: ThreadStatus }) {
  const meta = () => statusMeta[props.status];
  return (
    <View class="h-3.5 w-3.5 shrink-0 items-center justify-center">
      <If when={meta().glyph !== "dot"} else={<Dot tone={meta().dot} size={7} ring={false} />}>
        <Icon name={meta().glyph === "check" ? "check" : meta().glyph === "cross" ? "cross" : "warn"} size={12} />
      </If>
    </View>
  );
}

export function SubagentProgress(props: { session: string; progress: SubagentSummary; now: number }) {
  const picked = signal<{ session: string; run: string; thread: string }>();
  const selected = (id: string) => picked()?.session === props.session && picked()?.run === props.progress.run && picked()?.thread === id;
  const labels = createMemo(() => describeSubagents(props.progress));
  return (
    <View testID="subagent-progress" class="my-2 gap-1.5">
      <View class="flex-row items-center gap-2">
        <Text role="header" class="text-sm font-semibold text-ink">
          {t("web.session.subagents.heading")}
        </Text>
        <CountPill count={props.progress.threads.length} />
      </View>
      <If when={props.progress.disconnectedAt}>
        {(at) => (
          <Banner tone="warn" size="sm" testID="subagent-disconnected" textClass="tabular-nums">
            {t("web.session.subagents.disconnected", { ago: ago(at(), props.now) })}
          </Banner>
        )}
      </If>
      <Each of={labels().waits} key={(wait) => wait.key}>
        {(wait) => (
          <View class="flex-row items-center gap-2 rounded-md px-2.5 py-1.5" style={{ backgroundColor: mix("water", 0.1) }}>
            <Icon name="wait" size={12} tone="water" />
            <Text testID="subagent-wait" class="min-w-0 flex-1 text-xs font-medium text-water">
              {wait().text}
            </Text>
          </View>
        )}
      </Each>
      <Each of={props.progress.threads} key={(thread) => thread.threadId}>
        {(thread) => {
          const status = (): ThreadStatus => thread().status ?? "unknown";
          const meta = () => statusMeta[status()];
          const isOpen = () => selected(thread().threadId);
          const stepsCount = () => thread().steps?.length ?? 0;
          const stepsDone = () => thread().steps?.filter((s) => s.status === "completed").length ?? 0;
          const observedText = () =>
            t("web.session.subagents.observed", {
              status: t(`web.session.subagents.status.${status()}`),
              ago: ago(thread().updatedAt, props.now),
            });
          return (
            <View
              class="overflow-hidden rounded-md border border-line bg-page"
              style={status() === "errored" ? { borderColor: mix("berry", 0.35) } : undefined}
            >
              <View
                role="button"
                testID={`subagent-${thread().threadId}`}
                accessibilityLabel={t("web.session.subagents.openLog", { task: labels().name(thread().threadId) })}
                accessibilityState={{ expanded: isOpen() }}
                class={`gap-1 px-2.5 py-2 focus-visible:outline-2 focus-visible:outline-focus ${isOpen() ? "bg-hover" : "hover:bg-hover"}`}
                onPress={() => picked.set(isOpen() ? undefined : { session: props.session, run: props.progress.run, thread: thread().threadId })}
              >
                <View class="flex-row items-center gap-2">
                  <View
                    class={`h-3.5 w-3.5 shrink-0 items-center justify-center ${motionClass("transition-transform duration-120 ease-out")}`}
                    style={{ transform: [{ rotate: isOpen() ? "90deg" : "0deg" }] }}
                  >
                    <Icon name="expand" size={10} tone="muted" />
                  </View>
                  <StatusGlyph status={status()} />
                  <Text class="min-w-0 flex-1 truncate text-sm font-medium text-ink">{labels().name(thread().threadId)}</Text>
                  <View class="shrink-0 flex-row items-center gap-2">
                    <If when={stepsCount() > 0}>
                      <Text class="font-mono text-2xs text-muted tabular-nums">{`${stepsDone()}/${stepsCount()}`}</Text>
                    </If>
                    <View
                      class={`rounded-sm px-1.5 py-px ${meta().pillClass}`}
                      style={(() => {
                        const bg = meta().pillBg;
                        return bg ? { backgroundColor: bg() } : undefined;
                      })()}
                    >
                      <Text class={`text-2xs font-medium ${meta().pillText}`}>{t(`web.session.subagents.status.${status()}`)}</Text>
                    </View>
                    <View tooltip={<Bubble text={observedText()} />}>
                      <Text class="text-right text-2xs text-faint tabular-nums">{ago(thread().updatedAt, props.now)}</Text>
                    </View>
                  </View>
                </View>
                <If when={lastActivity(thread()) || thread().parentThreadId}>
                  <View class="gap-0.5 pl-11">
                    <If when={lastActivity(thread())}>
                      {(activity) => (
                        <Text
                          class={`text-xs ${status() === "errored" ? "text-berry" : status() === "running" ? "text-ink" : "text-muted"}`}
                          style={{ numberOfLines: isOpen() ? 4 : 2 }}
                        >
                          {activity()}
                        </Text>
                      )}
                    </If>
                    <If when={thread().parentThreadId}>
                      {(parent) => <Text class="text-2xs text-faint">{t("web.session.subagents.creator", { who: labels().name(parent()) })}</Text>}
                    </If>
                  </View>
                </If>
              </View>
              <If when={isOpen()}>
                <View class="border-t border-line bg-side py-2.5 pr-2.5 pl-6">
                  <If when={stepsCount() > 0}>
                    <View testID="subagent-steps" class="mb-2.5 gap-1">
                      <View class="flex-row items-center gap-2">
                        <Text class="text-xs font-semibold text-muted">{t("web.session.subagents.steps.title")}</Text>
                        <Text class="font-mono text-2xs text-faint tabular-nums">{`${stepsDone()}/${stepsCount()}`}</Text>
                      </View>
                      <Each of={thread().steps ?? []}>
                        {(item) => (
                          <View class="flex-row items-start gap-2 py-0.5">
                            <View class="mt-0.5 h-3.5 w-3.5 shrink-0 items-center justify-center">
                              <If
                                when={item().status === "completed"}
                                else={<Dot tone={item().status === "inProgress" ? "water" : "idle"} size={6} ring={false} />}
                              >
                                <Icon name="check" size={12} />
                              </If>
                            </View>
                            <Text class={`w-12 shrink-0 text-xs font-medium ${stepStatusText[item().status]}`}>
                              {t(`web.session.subagents.steps.${item().status}`)}
                            </Text>
                            <Text class={`min-w-0 flex-1 text-xs ${item().status === "completed" ? "text-muted" : "text-ink"}`}>{item().step}</Text>
                          </View>
                        )}
                      </Each>
                    </View>
                  </If>
                  <ThreadLog session={props.session} run={props.progress.run} thread={thread().threadId} now={props.now} />
                </View>
              </If>
            </View>
          );
        }}
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
      <If when={log().length > 0} else={<Text class="text-xs text-faint">{t("web.session.subagents.noLog")}</Text>}>
        <Scroll class="max-h-88" contentClass="gap-1" accessibilityLabel={t("web.session.log.process")}>
          <Each of={log()} key={(step) => step.seq}>
            {(step) => <WorkLogStep step={step()} now={props.now} />}
          </Each>
        </Scroll>
      </If>
    </View>
  );
}
