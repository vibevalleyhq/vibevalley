import { Clipboard, computed, Scroll, signal, Text, untracked, View } from "nsh";
import { TextView } from "nsh/base";

import { t } from "@vibevalley/i18n";
import type { ChatToolStepProjection } from "@vibevalley/protocol";

import { Button } from "../../design/Button";
import { CodeBlock } from "../../design/code/CodeBlock";
import { Diagram } from "../../design/code/Diagram";
import { TextInput } from "../../design/Field";
import { Icon } from "../../design/Icon";
import { actionIcon, type IconName } from "../../design/icons";
import { motionClass } from "../../design/motion";
import { Dot } from "../../design/Tag";
import { mix } from "../../design/tone";
import { useNow } from "../../infra/base/dom";
import { act, hostApi } from "../../infra/bridge";
import { richNative, type VvDiagramPressEvent, type VvGenUiActionEvent } from "../../infra/rich";
import {
  extractToolTarget,
  formatDurationMs,
  formatToolDetails,
  parseTodoChecklist,
  thinkingPreview,
  type ActivitySummary,
  type ChatFeedItem,
  type SessionEvent,
  type SessionInteractionRequest,
  type SessionPermissionDecision,
  type SessionPermissionRequest,
  type ThoughtLevel,
  type TodoChecklist,
  type TodoStep,
} from "../chatSession";
import { ShellIconButton } from "../chrome";

function actionIconFor(action: SessionEvent["action"]): IconName {
  if (action !== undefined && action in actionIcon) return actionIcon[action];
  return "bolt";
}

export function thoughtLabel(level: ThoughtLevel): string {
  switch (level) {
    case "minimal":
      return "Min";
    case "low":
      return t("web.shell.chat.thoughtLow");
    case "medium":
      return t("web.shell.chat.thoughtMedium");
    case "high":
      return t("web.shell.chat.thoughtHigh");
    case "xhigh":
    case "max":
      return t("web.shell.chat.thoughtMax");
  }
}

function activitySummaryLabel(summary: ActivitySummary): string {
  const parts: string[] = [];
  if (summary.thinkingCount > 0) parts.push(t("web.shell.chat.activityThinking", { n: summary.thinkingCount }));
  if (summary.readCount > 0) parts.push(t("web.shell.chat.activityRead", { n: summary.readCount }));
  if (summary.searchCount > 0) parts.push(t("web.shell.chat.activitySearch", { n: summary.searchCount }));
  if (summary.editCount > 0) parts.push(t("web.shell.chat.activityEdit", { n: summary.editCount }));
  if (summary.commandCount > 0) parts.push(t("web.shell.chat.activityCommand", { n: summary.commandCount }));
  if (summary.otherToolCount > 0) parts.push(t("web.shell.chat.activityOther", { n: summary.otherToolCount }));
  return parts.join(" · ") || t("web.shell.chat.activitySteps", { n: summary.totalSteps });
}

export function ChatMarkdown(props: {
  text: string;
  streaming?: boolean;
  onGenUiAction?: (event: VvGenUiActionEvent) => void;
  onDiagramPress?: (event: VvDiagramPressEvent) => void;
}) {
  const native = richNative();
  const openLink = (url: string) => {
    if (url.startsWith("/")) {
      act({ type: "open_route", path: url });
    } else if (url.startsWith("file://")) {
      act({ type: "open_file_adjacent", path: decodeURI(url.slice("file://".length)) });
    } else {
      void hostApi.openUrl(url);
    }
  };
  const handleGenUiAction = (event: VvGenUiActionEvent) => {
    if (props.onGenUiAction) {
      props.onGenUiAction(event);
      return;
    }
    if (event.action.trim() === "navigate" && event.payload.trim().startsWith("/")) {
      act({ type: "open_route", path: event.payload.trim() });
    }
  };
  if (native) {
    const VvMarkdown = native.VvMarkdown;
    return (
      <VvMarkdown
        text={props.text}
        size="sm"
        streaming={props.streaming === true}
        selectable
        onLinkPress={(e) => openLink(e.url)}
        onGenUiAction={handleGenUiAction}
        onDiagramPress={props.onDiagramPress}
      />
    );
  }
  return (
    <TextView
      markdown={props.text}
      selectable
      onLinkPress={(e) => openLink(e.url)}
      renderCodeBlock={(block) => {
        switch (block.language) {
          case "mermaid":
            return <Diagram source={block.code} interactive onPress={props.onDiagramPress} />;
          default:
            return <CodeBlock code={block.code} language={block.language} />;
        }
      }}
    />
  );
}

function CopyTextButton(props: { text: string }) {
  const copied = signal(false);
  let resetTimer: ReturnType<typeof setTimeout> | undefined;
  const copy = () => {
    void Clipboard.writeText(props.text).then(
      () => {
        copied.set(true);
        if (resetTimer !== undefined) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          resetTimer = undefined;
          copied.set(false);
        }, 1_500);
      },
      () => undefined,
    );
  };
  return (
    <ShellIconButton
      compact
      icon={copied() ? "check" : "copy"}
      tone={copied() ? "ok-ink" : undefined}
      size={11}
      label={copied() ? t("web.shell.chat.copied") : t("web.shell.chat.copy")}
      onPress={copy}
    />
  );
}

function DurationPill(props: { durationMs?: number | undefined }) {
  const duration = computed(() => formatDurationMs(props.durationMs));
  return (
    <If when={duration()}>
      {(dur) => (
        <View class="shrink-0 rounded-full border border-line bg-page px-1.5 py-px">
          <Text class="font-mono text-2xs text-muted tabular-nums">{dur()}</Text>
        </View>
      )}
    </If>
  );
}

function LiveDurationPill(props: { startedAt: number }) {
  const now = useNow(1_000);
  const elapsed = computed(() => Math.max(0, now() - props.startedAt));
  return <DurationPill durationMs={elapsed()} />;
}

function TodoChecklistRows(props: { readonly steps: readonly TodoStep[] }) {
  return (
    <Each of={props.steps} key={(_, idx) => String(idx)}>
      {(entry) => (
        <View
          class="min-h-6 flex-row items-center gap-2 rounded-sm px-2 py-0.5"
          style={entry().status === "in_progress" ? { backgroundColor: mix("water", 0.08) } : undefined}
        >
          <If when={entry().status === "done"}>
            <View class="size-3 shrink-0 items-center justify-center">
              <Icon name="ticked" size={12} tone="ok-ink" />
            </View>
          </If>
          <If when={entry().status === "in_progress"}>
            <View class="size-3 shrink-0 items-center justify-center">
              <Dot tone="water" size={6} ring={false} />
            </View>
          </If>
          <If when={entry().status === "pending"}>
            <View class="size-3 shrink-0 items-center justify-center">
              <View class="size-2 rounded-full border border-faint" />
            </View>
          </If>
          <If when={entry().status === "failed"}>
            <Icon name="cross" size={12} tone="berry" />
          </If>
          <If when={entry().status === "skipped"}>
            <Icon name="minus" size={12} tone="faint" />
          </If>
          <Text
            class={
              entry().status === "in_progress"
                ? "min-w-0 flex-1 text-xs font-medium text-ink"
                : entry().status === "failed"
                  ? "min-w-0 flex-1 text-xs text-berry"
                  : entry().status === "skipped"
                    ? "min-w-0 flex-1 text-xs text-faint line-through"
                    : "min-w-0 flex-1 text-xs text-muted"
            }
          >
            {entry().title}
          </Text>
        </View>
      )}
    </Each>
  );
}

export function TodoProgressPanel(props: { readonly checklist: TodoChecklist; readonly working: boolean }) {
  const toggled = signal<boolean>();
  const active = computed(() => props.checklist.inProgressCount > 0 || (props.working && props.checklist.doneCount < props.checklist.totalCount));
  const open = computed(() => toggled() ?? active());
  const pct = computed(() => (props.checklist.totalCount > 0 ? Math.min(100, Math.round((props.checklist.doneCount / props.checklist.totalCount) * 100)) : 0));

  return (
    <View testID="chat-todo-panel" class="overflow-hidden rounded-lg border border-line bg-side">
      <View
        role="button"
        testID="chat-todo-toggle"
        accessibilityState={{ expanded: open() }}
        onPress={() => toggled.set(!open())}
        class="min-h-7.5 flex-row items-center gap-1.5 px-2.5 py-1 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
      >
        <View
          class={`size-3.5 shrink-0 items-center justify-center ${motionClass("transition-transform duration-120 ease-out")}`}
          style={{ transform: [{ rotate: open() ? "90deg" : "0deg" }] }}
        >
          <Icon name="expand" size={10} tone="muted" />
        </View>
        <If
          when={active()}
          else={
            <If
              when={props.checklist.failedCount > 0}
              else={
                <If when={props.checklist.doneCount === props.checklist.totalCount} else={<Icon name="partly" size={12} tone="muted" />}>
                  <Icon name="ticked" size={12} tone="ok-ink" />
                </If>
              }
            >
              <Icon name="cross" size={12} tone="berry" />
            </If>
          }
        >
          <Dot tone="water" size={6} ring={false} />
        </If>
        <Text class="shrink-0 text-xs font-medium text-ink">{t("web.shell.chat.todoTitle")}</Text>
        <If when={!open() && props.checklist.activeStep !== undefined}>
          <Text class="min-w-0 flex-1 truncate text-xs text-muted">{props.checklist.activeStep?.title ?? ""}</Text>
        </If>
        <If when={open() || props.checklist.activeStep === undefined}>
          <View class="flex-1" />
        </If>
        <View class="h-1.5 w-14 shrink-0 overflow-hidden rounded-full bg-selected">
          <View class="h-full bg-accent" style={{ width: `${pct()}%` }} />
        </View>
        <Text testID="chat-todo-fraction" class="shrink-0 font-mono text-2xs font-medium text-muted tabular-nums">
          {`${props.checklist.doneCount}/${props.checklist.totalCount}`}
        </Text>
      </View>
      <If when={open()}>
        <Scroll testID="chat-todo-list" class="max-h-40 border-t border-line bg-page" contentClass="gap-0.5 px-1.5 py-1">
          <TodoChecklistRows steps={props.checklist.steps} />
        </Scroll>
      </If>
    </View>
  );
}

export function ThinkingBlock(props: { step: SessionEvent; durationMs?: number | undefined; running?: boolean | undefined; embedded?: boolean | undefined }) {
  const open = signal(false);
  const preview = computed(() => thinkingPreview(props.step.text));
  const embedded = () => props.embedded === true;
  return (
    <View testID="chat-thinking" class={embedded() ? "bg-transparent" : "rounded-lg border border-line bg-side"}>
      <View
        role="button"
        testID={`chat-thinking-toggle-${props.step.seq}`}
        accessibilityState={{ expanded: open() }}
        onPress={() => open.set(!open())}
        class={
          embedded()
            ? "min-h-6 flex-row items-center gap-1.5 rounded-sm py-0.5 pr-2.5 pl-4 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
            : "h-7 flex-row items-center gap-1.5 px-2.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
        }
      >
        <View
          class={`size-3.5 shrink-0 items-center justify-center ${motionClass("transition-transform duration-120 ease-out")}`}
          style={{ transform: [{ rotate: open() ? "90deg" : "0deg" }] }}
        >
          <Icon name="expand" size={10} tone="muted" />
        </View>
        <Icon name="idea" size={embedded() ? 11 : 12} tone="muted" />
        <Text class="shrink-0 text-xs font-medium text-muted">{t("web.shell.chat.thinking")}</Text>
        <If when={!open() && preview().length > 0}>
          <Text class="min-w-0 flex-1 truncate text-xs text-faint">{preview()}</Text>
        </If>
        <If when={open() || preview().length === 0}>
          <View class="flex-1" />
        </If>
        <If when={props.running === true} else={<DurationPill durationMs={props.durationMs} />}>
          <LiveDurationPill startedAt={props.step.time} />
        </If>
      </View>
      <If when={open()}>
        <View class={embedded() ? "mx-2.5 mb-1 gap-1.5 rounded-md border border-line bg-side px-2.5 py-1.5" : "gap-1.5 border-t border-line bg-page px-3 py-2"}>
          <View class="flex-row items-center justify-end">
            <CopyTextButton text={props.step.text} />
          </View>
          <Text class="text-xs leading-5 text-muted select-text">{props.step.text}</Text>
        </View>
      </If>
    </View>
  );
}

export function ToolCallCard(props: {
  step: SessionEvent;
  durationMs?: number | undefined;
  embedded?: boolean | undefined;
  projected?: ChatToolStepProjection | undefined;
}) {
  const toggled = signal<boolean>();
  const open = computed(() => toggled() ?? props.step.ok === false);
  const target = computed(() => (props.projected ? props.projected.target : extractToolTarget(props.step)));
  const details = computed(() => props.projected?.details ?? formatToolDetails(props.step));
  const todo = computed(() => (props.projected ? props.projected.todo : parseTodoChecklist(props.step)));
  const embedded = () => props.embedded === true;
  const running = () => props.step.ok === undefined;
  const failed = () => props.step.ok === false;
  const statusText = () => (running() ? t("web.shell.chat.toolRunning") : failed() ? t("web.shell.chat.toolFailed") : t("web.shell.chat.toolOk"));
  const iconTone = () => {
    if (failed()) return "berry";
    if (running()) return "water";
    const checklist = todo();
    if (checklist !== undefined && checklist.doneCount === checklist.totalCount) return "ok-ink";
    return "muted";
  };

  return (
    <View testID={`chat-tool-${props.step.seq}`} class={embedded() ? "bg-transparent" : "rounded-lg border border-line bg-side"}>
      <View class={embedded() ? "min-h-6 flex-row items-center gap-1.5 py-0 pr-2 pl-4" : "min-h-8 flex-row items-center gap-1.5 px-2 py-1"}>
        <View
          role="button"
          testID={`chat-tool-toggle-${props.step.seq}`}
          accessibilityState={{ expanded: open() }}
          onPress={() => toggled.set(!open())}
          class="min-w-0 flex-1 flex-row items-center gap-1.5 rounded-sm px-1 py-0.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
        >
          <View
            class={`size-3.5 shrink-0 items-center justify-center ${motionClass("transition-transform duration-120 ease-out")}`}
            style={{ transform: [{ rotate: open() ? "90deg" : "0deg" }] }}
          >
            <Icon name="expand" size={10} tone="muted" />
          </View>
          <Icon name={todo() !== undefined ? "ticked" : actionIconFor(props.step.action)} size={embedded() ? 12 : 14} tone={iconTone()} />
          <Text class={`shrink-0 text-xs font-medium ${failed() ? "text-berry" : "text-ink"}`}>
            {todo() !== undefined ? t("web.shell.chat.todoToolLabel") : (props.step.actionText ?? props.step.tool ?? "")}
          </Text>
          <Text class={`min-w-0 flex-1 truncate font-mono text-xs ${failed() ? "text-berry" : "text-muted"}`}>{details().headline}</Text>
          <View class="shrink-0 flex-row items-center gap-1.5">
            <If when={running()} else={<DurationPill durationMs={props.durationMs} />}>
              <LiveDurationPill startedAt={props.step.time} />
            </If>
            <If when={running()} else={<Icon name={failed() ? "cross" : "check"} size={12} />}>
              <Dot tone="water" size={6} ring={false} />
            </If>
            <Text class={`text-2xs ${failed() ? "text-berry" : running() ? "text-water" : "text-faint"}`}>{statusText()}</Text>
          </View>
        </View>
        <If when={target()}>
          {(hit) => (
            <View class="shrink-0 flex-row items-center gap-0.5">
              <ShellIconButton
                compact
                icon="file"
                label={t("web.shell.chat.toolOpenFile")}
                onPress={() =>
                  act({
                    type: "open_file_adjacent",
                    path: hit().path,
                    ...(hit().line !== undefined ? { line: hit().line } : {}),
                  })
                }
              />
              <If when={hit().canDiff}>
                <ShellIconButton
                  compact
                  icon="diff"
                  label={t("web.shell.chat.toolOpenDiff")}
                  onPress={() => act({ type: "open_diff_adjacent", path: hit().path, staged: false })}
                />
              </If>
            </View>
          )}
        </If>
      </View>
      <If when={open()}>
        <View class={embedded() ? "mx-2.5 mb-1 gap-1.5 rounded-md border border-line bg-side p-2" : "gap-2 border-t border-line bg-page p-2.5"}>
          <If
            when={todo()}
            else={
              <>
                <If when={details().formattedInput.length > 0}>
                  <View class="gap-1">
                    <View class="flex-row items-center justify-between gap-2">
                      <Text class="text-2xs font-semibold text-muted">{t("web.shell.chat.toolInput")}</Text>
                      <CopyTextButton text={details().formattedInput} />
                    </View>
                    <Scroll class="max-h-36 rounded-md border border-line bg-code-bg px-2.5 py-2">
                      <Text class="font-mono text-xs text-code-ink select-text">{details().formattedInput}</Text>
                    </Scroll>
                  </View>
                </If>
                <If
                  when={props.step.output}
                  else={<Text class="text-xs text-faint">{running() ? t("web.shell.chat.toolPending") : t("web.shell.chat.toolNoOutput")}</Text>}
                >
                  {(out) => (
                    <View class="gap-1">
                      <View class="flex-row items-center justify-between gap-2">
                        <View class="flex-row items-center gap-1.5">
                          <Text class={`text-2xs font-semibold ${failed() ? "text-berry" : "text-muted"}`}>{t("web.shell.chat.toolOutput")}</Text>
                          <If when={details().outputLines > 0}>
                            <Text class="font-mono text-2xs text-faint tabular-nums">{t("web.shell.chat.toolLines", { n: details().outputLines })}</Text>
                          </If>
                        </View>
                        <CopyTextButton text={out()} />
                      </View>
                      <Scroll class={`max-h-48 rounded-md border px-2.5 py-2 ${failed() ? "border-berry bg-bad-soft" : "border-line bg-side"}`}>
                        <Text class={`font-mono text-xs select-text ${failed() ? "text-berry" : "text-ink"}`}>{out()}</Text>
                      </Scroll>
                    </View>
                  )}
                </If>
              </>
            }
          >
            {(checklist) => (
              <View class="gap-0.5">
                <TodoChecklistRows steps={checklist().steps} />
              </View>
            )}
          </If>
        </View>
      </If>
    </View>
  );
}

export function MemoryRecalledRow(props: { step: SessionEvent; embedded?: boolean | undefined }) {
  const embedded = () => props.embedded === true;
  return (
    <View
      testID={`chat-memory-${props.step.seq}`}
      class={
        embedded()
          ? "min-h-6 flex-row items-center gap-1.5 bg-transparent py-0.5 pr-2.5 pl-4"
          : "flex-row items-center gap-1.5 rounded-lg border border-line bg-side px-2.5 py-1.5"
      }
    >
      <Icon name="log" size={12} tone="muted" />
      <Text class="min-w-0 flex-1 truncate text-xs text-muted">{props.step.text || t("web.session.runs.span.recalled")}</Text>
    </View>
  );
}

export function ActivityGroup(props: {
  item: Extract<ChatFeedItem, { kind: "activity" }>;
  working: boolean;
  toolEntries?: ReadonlyMap<number, ChatToolStepProjection> | undefined;
}) {
  const toggled = signal<boolean>();
  const autoOpen = computed(() => props.item.summary.runningCount > 0 || props.item.summary.failedCount > 0 || (props.item.trailing && props.working));
  const open = computed(() => toggled() ?? autoOpen());
  const running = () => props.item.summary.runningCount > 0 || (props.item.trailing && props.working);
  const failed = () => props.item.summary.failedCount > 0;
  const label = computed(() => activitySummaryLabel(props.item.summary));

  return (
    <View testID={`chat-activity-${props.item.key}`} class="overflow-hidden rounded-lg border border-line bg-side">
      <View
        role="button"
        testID={`chat-activity-toggle-${props.item.key}`}
        accessibilityState={{ expanded: open() }}
        onPress={() => toggled.set(!open())}
        class="min-h-8 flex-row items-center gap-1.5 px-2.5 py-1.5 hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
      >
        <View
          class={`size-3.5 shrink-0 items-center justify-center ${motionClass("transition-transform duration-120 ease-out")}`}
          style={{ transform: [{ rotate: open() ? "90deg" : "0deg" }] }}
        >
          <Icon name="expand" size={10} tone="muted" />
        </View>
        <If
          when={running()}
          else={
            <If when={failed()} else={<Icon name="check" size={12} tone="ok-ink" />}>
              <Icon name="cross" size={12} tone="berry" />
            </If>
          }
        >
          <Dot tone="water" size={6} ring={false} />
        </If>
        <Text class={`min-w-0 flex-1 truncate text-xs font-medium ${failed() ? "text-berry" : running() ? "text-water" : "text-muted"}`}>{label()}</Text>
        <View class="shrink-0 flex-row items-center gap-1.5">
          <If when={failed()}>
            <View class="rounded-sm bg-bad-soft px-1.5 py-px">
              <Text class="text-2xs font-medium text-berry">{t("web.shell.chat.activityFailed", { n: props.item.summary.failedCount })}</Text>
            </View>
          </If>
          <If when={running()}>
            <Text class="text-2xs font-medium text-water">{t("web.shell.chat.activityRunning")}</Text>
          </If>
          <Text class="text-2xs text-faint tabular-nums">{t("web.shell.chat.activitySteps", { n: props.item.summary.totalSteps })}</Text>
          <If when={running()} else={<DurationPill durationMs={props.item.summary.durationMs} />}>
            <LiveDurationPill startedAt={props.item.summary.startedAt} />
          </If>
        </View>
      </View>

      <If when={!open() && props.item.summary.latestCommand !== undefined}>
        <View testID={`chat-activity-latest-cmd-${props.item.key}`} class="flex-row items-center gap-1.5 border-t border-line bg-page px-2.5 py-1">
          <Icon
            name="terminal"
            size={11}
            tone={props.item.summary.latestCommand?.failed === true ? "berry" : props.item.summary.latestCommand?.running === true ? "water" : "muted"}
          />
          <Text class={`min-w-0 flex-1 truncate font-mono text-xs ${props.item.summary.latestCommand?.failed === true ? "text-berry" : "text-muted"}`}>
            {`$ ${props.item.summary.latestCommand?.command ?? ""}`}
          </Text>
          <If
            when={props.item.summary.latestCommand?.running === true}
            else={
              <Icon
                name={props.item.summary.latestCommand?.failed === true ? "cross" : "check"}
                size={11}
                tone={props.item.summary.latestCommand?.failed === true ? "berry" : "ok-ink"}
              />
            }
          >
            <Dot tone="water" size={5} ring={false} />
          </If>
        </View>
      </If>

      <If when={!open() && props.item.summary.editedFiles.length > 0}>
        <View class="border-t border-line bg-page px-2.5 py-1">
          <Each of={props.item.summary.editedFiles} key={(f) => f.path}>
            {(hit) => (
              <View class="min-h-7 flex-row items-center gap-1.5">
                <Icon name="edit" size={12} tone="muted" />
                <Text class="min-w-0 flex-1 truncate font-mono text-xs text-muted">{hit().path}</Text>
                <View class="shrink-0 flex-row items-center gap-0.5">
                  <ShellIconButton
                    compact
                    icon="file"
                    label={t("web.shell.chat.toolOpenFile")}
                    onPress={() =>
                      act({
                        type: "open_file_adjacent",
                        path: hit().path,
                        ...(hit().line !== undefined ? { line: hit().line } : {}),
                      })
                    }
                  />
                  <ShellIconButton
                    compact
                    icon="diff"
                    label={t("web.shell.chat.toolOpenDiff")}
                    onPress={() => act({ type: "open_diff_adjacent", path: hit().path, staged: false })}
                  />
                </View>
              </View>
            )}
          </Each>
        </View>
      </If>

      <If when={open()}>
        <View testID={`chat-activity-steps-${props.item.key}`} class="border-t border-line bg-page py-0.5">
          <Each of={props.item.steps} key={(entry) => entry.step.seq}>
            {(entry, index) => (
              <View testID={`chat-step-${entry().step.seq}`}>
                <If when={entry().step.type === "assistant/thinking"}>
                  <ThinkingBlock step={entry().step} durationMs={entry().durationMs} running={running() && index() === props.item.steps.length - 1} embedded />
                </If>
                <If when={entry().step.type === "tool/call"}>
                  <ToolCallCard step={entry().step} durationMs={entry().durationMs} embedded projected={props.toolEntries?.get(entry().step.seq)} />
                </If>
                <If when={entry().step.type === "memory/recalled"}>
                  <MemoryRecalledRow step={entry().step} embedded />
                </If>
              </View>
            )}
          </Each>
        </View>
      </If>
    </View>
  );
}

export function InteractionCard(props: {
  interaction: SessionInteractionRequest;
  busy: boolean;
  onRespond: (decision: { kind: "select"; optionId: string } | { kind: "custom"; text: string } | { kind: "cancel" }) => void;
}) {
  const selectedId = signal<string>(untracked(() => props.interaction.options[0]?.id ?? ""));
  const custom = signal("");
  const canConfirm = () => custom().trim().length > 0 || selectedId().length > 0;
  const submit = () => {
    const trimmed = custom().trim();
    if (trimmed.length > 0) {
      props.onRespond({ kind: "custom", text: trimmed });
      return;
    }
    if (selectedId().length > 0) {
      props.onRespond({ kind: "select", optionId: selectedId() });
    }
  };

  return (
    <View
      testID={`chat-interaction-${props.interaction.requestId}`}
      class="gap-2.5 rounded-lg border border-line bg-elevated p-3 shadow-raise"
      style={{ borderLeftColor: mix("wheat", 0.95) }}
    >
      <View class="flex-row flex-wrap items-center gap-2">
        <View class="h-5 flex-row items-center gap-1 rounded-sm bg-warn-soft px-2">
          <Icon name="warn" size={12} tone="warn-ink" />
          <Text class="text-2xs font-semibold text-warn-ink">{t("web.shell.chat.interactionBadge")}</Text>
        </View>
        <Text class="font-mono text-2xs text-faint">{props.interaction.requestId}</Text>
      </View>
      <Text class="text-sm font-semibold text-ink">{props.interaction.question}</Text>
      <If when={props.interaction.options.length > 0}>
        <View class="gap-1.5">
          <Each of={props.interaction.options} key={(o) => o.id}>
            {(opt) => {
              const chosen = () => custom().trim().length === 0 && selectedId() === opt().id;
              return (
                <View
                  role="button"
                  testID={`chat-interaction-option-${opt().id}`}
                  accessibilityState={{ selected: chosen() }}
                  onPress={() => {
                    selectedId.set(opt().id);
                    custom.set("");
                  }}
                  class={`gap-0.5 rounded-md border px-2.5 py-2 focus-visible:outline-2 focus-visible:outline-focus ${
                    chosen() ? "border-accent bg-ok-soft" : "border-line bg-page hover:bg-hover"
                  }`}
                >
                  <View class="flex-row items-center gap-2">
                    <Icon name={chosen() ? "ticked" : "choose"} size={12} tone={chosen() ? "accent" : "muted"} />
                    <Text class="min-w-0 flex-1 text-sm font-medium text-ink">{opt().label}</Text>
                  </View>
                  <If when={opt().description}>{(desc) => <Text class="pl-5 text-xs text-muted">{desc()}</Text>}</If>
                  <If when={opt().warning}>
                    {(warn) => (
                      <View class="mt-1 ml-5 flex-row items-center gap-1 rounded-sm bg-warn-soft px-1.5 py-0.5">
                        <Icon name="warn" size={12} tone="warn-ink" />
                        <Text class="min-w-0 flex-1 text-2xs text-warn-ink">{warn()}</Text>
                      </View>
                    )}
                  </If>
                </View>
              );
            }}
          </Each>
        </View>
      </If>
      <View class="flex-row items-center gap-2">
        <If when={props.interaction.allowCustom}>
          <TextInput
            testID={`chat-interaction-custom-${props.interaction.requestId}`}
            value={custom()}
            onInput={(v) => custom.set(v)}
            onSubmit={submit}
            placeholder={t("web.shell.chat.interactionCustomPlaceholder")}
            accessibilityLabel={t("web.shell.chat.interactionCustomPlaceholder")}
            class="min-w-0 flex-1"
            wide={false}
          />
        </If>
        <Button testID={`chat-interaction-decline-${props.interaction.requestId}`} disabled={props.busy} onPress={() => props.onRespond({ kind: "cancel" })}>
          {t("web.shell.chat.interactionDecline")}
        </Button>
        <Button tone="primary" testID={`chat-interaction-confirm-${props.interaction.requestId}`} disabled={props.busy || !canConfirm()} onPress={submit}>
          {t("web.shell.chat.interactionConfirm")}
        </Button>
      </View>
    </View>
  );
}

export function PermissionCard(props: { permission: SessionPermissionRequest; busy: boolean; onRespond: (decision: SessionPermissionDecision) => void }) {
  return (
    <View
      testID={`chat-permission-${props.permission.requestId}`}
      class="gap-2 rounded-lg border border-line bg-elevated p-3 shadow-raise"
      style={{ borderLeftColor: mix("wheat", 0.95) }}
    >
      <View class="flex-row items-center gap-2">
        <View class="h-5 flex-row items-center gap-1 rounded-sm bg-warn-soft px-2">
          <Icon name="lock" size={12} tone="warn-ink" />
          <Text class="text-2xs font-semibold text-warn-ink">{t("web.shell.chat.permissionBadge")}</Text>
        </View>
        <Text class="font-mono text-xs font-semibold text-ink">{props.permission.tool}</Text>
      </View>
      <If when={props.permission.summary}>
        <Text class="text-sm text-ink">{props.permission.summary}</Text>
      </If>
      <If when={props.permission.input}>
        {(raw) => (
          <Scroll class="max-h-28 rounded-md border border-line bg-code-bg px-2.5 py-1.5">
            <Text class="font-mono text-xs text-code-ink select-text">{raw()}</Text>
          </Scroll>
        )}
      </If>
      <View class="flex-row items-center justify-end gap-1.5">
        <Button
          tone="danger"
          size="compact"
          testID={`chat-permission-deny-${props.permission.requestId}`}
          disabled={props.busy}
          onPress={() => props.onRespond("deny")}
        >
          {t("web.shell.chat.permissionDeny")}
        </Button>
        <Button
          size="compact"
          testID={`chat-permission-session-${props.permission.requestId}`}
          disabled={props.busy}
          onPress={() => props.onRespond("allowAlways")}
        >
          {t("web.shell.chat.permissionAllowSession")}
        </Button>
        <Button
          tone="primary"
          size="compact"
          testID={`chat-permission-once-${props.permission.requestId}`}
          disabled={props.busy}
          onPress={() => props.onRespond("allowOnce")}
        >
          {t("web.shell.chat.permissionAllowOnce")}
        </Button>
      </View>
    </View>
  );
}

export function ContextBar(props: { cached: number; uncached: number; class: string }) {
  return (
    <View class={props.class}>
      <If when={props.cached > 0}>
        <View class="h-full bg-leaf" style={{ width: `${props.cached}%` }} />
      </If>
      <If when={props.uncached > 0}>
        <View class="h-full bg-water" style={{ width: `${props.uncached}%` }} />
      </If>
    </View>
  );
}
