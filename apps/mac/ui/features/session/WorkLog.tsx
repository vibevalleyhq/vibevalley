import { Clipboard, computed, Scroll, signal, Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import type { SessionEvent } from "@vibevalley/protocol";

import { Icon } from "../../design/Icon";
import { actionIcon, type IconName } from "../../design/icons";
import { Markdown } from "../../design/Markdown";
import { motionClass } from "../../design/motion";
import { Dot } from "../../design/Tag";
import { Bubble } from "../../design/Tip";
import { toast } from "../../design/toasts";
import { mix, tone } from "../../design/tone";
import { useNow } from "../../infra/base/dom";
import { ago, tookText } from "../../infra/base/format";
import { useTimeout } from "../../infra/base/timer";
import { createEffect } from "../../infra/solid";
import { createRunEvents } from "./events";
import {
  answerOf,
  farmToolText,
  isLongText,
  lastTime,
  readableInput,
  runLabel,
  runMs,
  runsOf,
  runTitle,
  type RunView,
  shownEvents,
  spanLabel,
  spansOf,
  spanTone,
  tokensText,
} from "./runs";

type LineKind = "retry" | "usage" | "error";

const lineKinds: Record<LineKind, { readonly bgClass: string; readonly text: string; readonly iconTone: string }> = {
  retry: { bgClass: "bg-warn-soft", text: "text-warn-ink", iconTone: "warn-ink" },
  usage: { bgClass: "bg-hover", text: "text-muted", iconTone: "muted" },
  error: { bgClass: "bg-bad-soft", text: "text-berry", iconTone: "berry" },
};

function usageLineText(step: SessionEvent): string {
  if (step.text) return step.text;
  if (!step.tokens) return "";
  return t("web.session.trajectory.tokens", {
    input: tokensText(Math.round(step.tokens.input + step.tokens.cacheRead)),
    output: tokensText(Math.round(step.tokens.output)),
  });
}

function RunClockLog(props: { steps: SessionEvent[] }) {
  const now = useNow();
  return <WorkLog steps={props.steps} now={now()} asked={t("web.session.log.heard")} class="mt-1.5" />;
}

/** Under a report or the orchestrator's answer: the run behind it, folded to one line until opened. */
export function RunSteps(props: { session: string; run: string | undefined; orchestrator?: boolean }) {
  const open = signal(false);
  createEffect(
    () => `${props.session}:${props.run ?? ""}`,
    () => open.set(false),
    { defer: true },
  );
  const steps = createRunEvents(
    () => props.session,
    () => props.run,
    () => !!props.run,
  );
  const label = () => (props.run ? runLabel(steps(), props.orchestrator ?? false) : undefined);
  return (
    <If when={label()}>
      {(text) => (
        <View class="mt-1.5">
          <View
            role="button"
            testID="run-steps"
            onPress={() => open.set(!open())}
            accessibilityState={{ expanded: open() }}
            class={`flex-row items-center gap-1.5 self-start rounded-md border px-2 py-1 ${
              open() ? "border-line bg-hover" : "border-transparent hover:border-line hover:bg-hover"
            }`}
          >
            <View
              class={`h-3.5 w-3.5 shrink-0 items-center justify-center ${motionClass("transition-transform duration-120 ease-out")}`}
              style={{ transform: [{ rotate: open() ? "90deg" : "0deg" }] }}
            >
              <Icon name="expand" size={10} tone="muted" />
            </View>
            <Icon name="log" size={12} tone="muted" />
            <Text class="text-xs font-medium text-muted tabular-nums">{text()}</Text>
          </View>
          <If when={open()}>
            <RunClockLog steps={steps()} />
          </If>
        </View>
      )}
    </If>
  );
}

/** A session's steps by run, each run folded to its answer but the last. Its height stops at 22rem, or at `height`. */
export function WorkLog(props: { steps: SessionEvent[]; now: number; asked?: string; working?: boolean; class?: string | undefined; height?: number }) {
  const shown = computed(() => shownEvents(props.steps));
  const runs = computed(() => runsOf(shown()));
  const firstAsked = computed(() => shown().find((s) => s.type === "user/message" && s.under === undefined)?.seq);
  return (
    <Scroll
      testID="work-log"
      class={`rounded-md border border-line bg-page ${props.class ?? ""}`}
      style={{ maxHeight: props.height ?? 352 }}
      accessibilityLabel={t("web.session.log.process")}
    >
      <Each of={runs()} key={(r) => r.run ?? (r.asked ?? r.steps[0])?.seq ?? -1}>
        {(r, i) => (
          <RunFold
            run={r()}
            last={i() === runs().length - 1}
            live={props.working === true && i() === runs().length - 1}
            now={props.now}
            label={runTitle(r(), firstAsked(), props.asked)}
          />
        )}
      </Each>
    </Scroll>
  );
}

function RunFold(props: { run: RunView; last: boolean; live: boolean; now: number; label: string }) {
  const toggled = signal<boolean>();
  const open = computed(() => toggled() ?? props.last);
  const end = () => (props.live ? props.now : (lastTime(props.run) ?? props.now));
  const hasError = computed(() => props.run.steps.some((s) => s.type === "run/error"));
  const shown = computed(() => {
    const answer = answerOf(props.run);
    return open() ? props.run.steps : answer ? [answer] : [];
  });
  return (
    <View testID="run" class={`gap-1.5 px-2.5 pt-2 pb-2.5 ${props.last ? "" : "border-b border-line"}`}>
      <View
        role="button"
        testID="run-fold"
        onPress={() => toggled.set(!open())}
        accessibilityLabel={open() ? t("web.session.log.fold") : t("web.session.log.unfold")}
        accessibilityState={{ expanded: open() }}
        class="flex-row items-center gap-2 rounded-md px-1.5 py-1 hover:bg-hover"
      >
        <View
          class={`h-3.5 w-3.5 shrink-0 items-center justify-center ${motionClass("transition-transform duration-120 ease-out")}`}
          style={{ transform: [{ rotate: open() ? "90deg" : "0deg" }] }}
        >
          <Icon name="expand" size={10} tone="muted" />
        </View>
        <View class="h-3.5 w-3.5 shrink-0 items-center justify-center">
          <If
            when={props.live}
            else={
              <If when={hasError()} else={<Icon name="check" size={12} />}>
                <Icon name="cross" size={12} />
              </If>
            }
          >
            <Dot tone="water" size={7} ring={false} />
          </If>
        </View>
        <Text class="min-w-0 flex-1 truncate text-sm font-semibold text-ink">{props.label}</Text>
        <View class="shrink-0 flex-row items-center gap-2">
          <Text class={`text-xs tabular-nums ${props.live ? "font-medium text-water" : hasError() ? "text-berry" : "text-muted"}`}>
            {`${t("web.session.log.steps", { n: props.run.steps.length, took: tookText(runMs(props.run, end())) })}${props.live ? t("web.session.log.live") : ""}`}
          </Text>
          <If when={props.run.asked}>{(asked) => <When at={asked().time} now={props.now} />}</If>
        </View>
      </View>
      <If when={props.run.asked}>
        {(asked) => (
          <View class="rounded-md border-l-2 px-3 py-2" style={{ backgroundColor: mix("wheat", 0.14), borderColor: mix("wheat", 0.65) }}>
            <Folded text={asked().text} lines={4} />
          </View>
        )}
      </If>
      <If when={props.run.steps.length > 0}>
        <TimeBar run={props.run} end={end()} />
      </If>
      <Each of={shown()} key={(s) => s.seq}>
        {(s) => (
          <View class={s().under !== undefined ? "ml-5 border-l-2 pl-2.5" : ""} style={s().under !== undefined ? { borderColor: mix("leaf", 0.5) } : undefined}>
            <WorkLogStep step={s()} now={props.now} />
          </View>
        )}
      </Each>
      <If when={!open() && props.run.steps.length > shown().length}>
        <View
          role="button"
          testID="run-see"
          onPress={() => toggled.set(true)}
          class="flex-row items-center gap-1.5 self-start rounded-md px-2 py-1 focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover"
        >
          <Icon name="expand" size={10} tone="water" />
          <Text class="text-xs font-medium text-water tabular-nums">{t("web.session.log.see", { n: props.run.steps.length })}</Text>
        </View>
      </If>
    </View>
  );
}

function TimeBar(props: { run: RunView; end: number }) {
  const spans = computed(() => spansOf(props.run, props.end));
  // The shortest span still shows: at least 1/80 of the bar.
  const least = computed(() => {
    const total = spans().reduce((n, s) => n + s.ms, 0);
    return total <= 0 ? 1 : total / 80;
  });
  return (
    <View testID="time-bar" class="h-2 flex-row gap-px overflow-hidden rounded-sm bg-hover">
      <Each of={spans()} key={(s) => s.step.seq}>
        {(s) => (
          <View
            tooltip={<Bubble text={`${spanLabel(s().step)} · ${tookText(s().ms)}\n${s().step.text.split("\n")[0]}`} />}
            style={{ flexGrow: Math.max(1, Math.round((Math.max(s().ms, least()) / least()) * 10)), flexBasis: 0, backgroundColor: tone(spanTone(s().step)) }}
          />
        )}
      </Each>
    </View>
  );
}

function When(props: { at: number; now: number }) {
  return <Text class="shrink-0 text-right text-2xs text-faint tabular-nums">{ago(props.at, props.now)}</Text>;
}

function Folded(props: { text: string; lines: number; markdown?: boolean; muted?: boolean }) {
  const open = signal(false);
  const long = () => isLongText(props.text, props.lines);
  const clamp = () => long() && !open();
  return (
    <View class="items-start">
      <View class="w-full overflow-hidden" style={clamp() ? { maxHeight: props.lines * 20 } : undefined}>
        <If when={props.markdown === true} else={<Text class={`text-sm ${props.muted === true ? "text-muted" : "text-ink"}`}>{props.text}</Text>}>
          <Markdown size="sm" text={props.text} />
        </If>
      </View>
      <If when={long()}>
        <View
          role="button"
          onPress={() => open.set(!open())}
          class="mt-1 flex-row items-center gap-1 rounded-sm px-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover"
        >
          <Text class="text-xs font-medium text-water">{open() ? t("web.session.log.less") : t("web.session.log.all")}</Text>
        </View>
      </If>
    </View>
  );
}

function Box(props: { tint?: string; dashed?: boolean; label: string; step: SessionEvent; now: number; children: JSX.Element }) {
  return (
    <View
      testID="step"
      class={`rounded-md px-3 py-2 ${props.dashed === true ? "border border-dashed border-line bg-page" : ""}`}
      style={props.tint ? { backgroundColor: props.tint } : undefined}
    >
      <View class="mb-1 flex-row items-center gap-2">
        <Text class={`min-w-0 flex-1 truncate text-xs font-semibold text-muted ${props.dashed === true ? "italic" : ""}`}>{props.label}</Text>
        <When at={props.step.time} now={props.now} />
      </View>
      {props.children}
    </View>
  );
}

function Line(props: { mark: IconName; step: SessionEvent; now: number; kind: LineKind; text?: string }) {
  const style = () => lineKinds[props.kind];
  return (
    <View testID="step" class={`flex-row items-start gap-2 rounded-md px-2.5 py-1.5 ${style().bgClass}`}>
      <View class="mt-0.5 h-3.5 w-3.5 shrink-0 items-center justify-center">
        <Icon name={props.mark} size={12} tone={style().iconTone} />
      </View>
      <Text class={`min-w-0 flex-1 text-xs tabular-nums ${style().text}`}>{props.text ?? props.step.text}</Text>
      <When at={props.step.time} now={props.now} />
    </View>
  );
}

export function WorkLogStep(props: { step: SessionEvent; now: number }) {
  const sub = () => props.step.under !== undefined;
  const type = () => props.step.type;
  // Not rows: a run's bounds (each step carries its run), a result is shown in its call (shownEvents).
  return (
    <>
      <If when={type() === "user/message"}>
        <Box tint={mix("wheat", 0.14)} label={sub() ? t("web.session.log.subagentGot") : t("web.session.log.told")} step={props.step} now={props.now}>
          <Folded text={props.step.text} lines={4} />
        </Box>
      </If>
      <If when={type() === "memory/recalled"}>
        <Box tint={mix("leaf", 0.15)} label={t("web.session.log.recalled")} step={props.step} now={props.now}>
          <Folded text={props.step.text} lines={3} />
        </Box>
      </If>
      <If when={type() === "assistant/thinking"}>
        <Box dashed label={sub() ? t("web.session.log.subagentThought") : t("web.session.log.thought")} step={props.step} now={props.now}>
          <Folded text={props.step.text} lines={2} muted />
        </Box>
      </If>
      <If when={type() === "assistant/message"}>
        <Box tint={mix("hover", 1)} label={sub() ? t("web.session.log.subagentSaid") : t("web.session.log.said")} step={props.step} now={props.now}>
          <Folded text={props.step.text} lines={8} markdown />
        </Box>
      </If>
      <If when={type() === "tool/call"}>
        <ToolStep step={props.step} now={props.now} />
      </If>
      <If when={type() === "llm/retry"}>
        <Line mark="retry" step={props.step} now={props.now} kind="retry" />
      </If>
      <If when={type() === "llm/usage"}>
        <Line mark="spend" step={props.step} now={props.now} kind="usage" text={usageLineText(props.step)} />
      </If>
      <If when={type() === "run/error"}>
        <Line mark="cross" step={props.step} now={props.now} kind="error" />
      </If>
    </>
  );
}

function WorkLogCopyButton(props: { testID: string; copied: boolean; onCopy: () => void }) {
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={props.copied ? t("web.base.rich.copied") : t("web.base.rich.copy")}
      tooltip={<Bubble text={props.copied ? t("web.base.rich.copied") : t("web.base.rich.copy")} />}
      onPress={props.onCopy}
      class="flex-row items-center gap-1 rounded-sm px-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover"
    >
      <Icon name={props.copied ? "check" : "copy"} size={11} tone={props.copied ? "leaf" : "muted"} />
      <Text class={`text-2xs ${props.copied ? "font-medium text-ok-ink" : "text-muted"}`}>
        {props.copied ? t("web.base.rich.copied") : t("web.base.rich.copy")}
      </Text>
    </View>
  );
}

function ToolStep(props: { step: SessionEvent; now: number }) {
  const open = signal(false);
  const copiedSlot = signal<"input" | "output" | undefined>(undefined);
  const resetCopy = useTimeout();
  createEffect(
    () => props.step.seq,
    () => {
      open.set(false);
      copiedSlot.set(undefined);
    },
    { defer: true },
  );
  const copyPayload = (slot: "input" | "output", value: string) => {
    void Clipboard.writeText(value).then(
      () => {
        copiedSlot.set(slot);
        resetCopy(() => copiedSlot.set(undefined), 1500);
        toast(t("web.base.rich.copied"));
      },
      () => undefined,
    );
  };
  const farm = computed(() => farmToolText(props.step.text));
  const kind = () => (farm() ? t("web.session.log.farm") : (props.step.actionText ?? ""));
  const input = computed(() => readableInput(props.step));
  const running = () => props.step.ok === undefined;
  const failed = () => props.step.ok === false;
  const state = () => (running() ? t("web.session.log.running") : props.step.ok === true ? t("web.session.log.ok") : t("web.session.log.failed"));
  const badgeClass = () => (running() ? "" : failed() ? "bg-bad-soft" : "bg-ok-soft");
  const badgeText = () => (running() ? "text-water" : failed() ? "text-berry" : "text-ok-ink");
  return (
    <View testID="step">
      <View
        role="button"
        testID="tool-step"
        onPress={() => open.set(!open())}
        accessibilityState={{ expanded: open() }}
        class={`w-full flex-row items-center gap-2 rounded-md px-2 py-1.5 focus-visible:outline-2 focus-visible:outline-focus ${
          failed() ? "hover:bg-hover" : open() ? "bg-hover" : "hover:bg-hover"
        }`}
        style={failed() ? { backgroundColor: open() ? mix("bad-soft", 0.85) : mix("bad-soft", 0.45) } : undefined}
      >
        <View
          class={`h-3.5 w-3.5 shrink-0 items-center justify-center ${motionClass("transition-transform duration-120 ease-out")}`}
          style={{ transform: [{ rotate: open() ? "90deg" : "0deg" }] }}
        >
          <Icon name="expand" size={10} tone="muted" />
        </View>
        <View class="h-4 w-4 shrink-0 items-center justify-center">
          <Icon name={actionIcon[props.step.action ?? "other"]} size={14} tone={failed() ? "berry" : running() ? "water" : "muted"} />
        </View>
        <Text class={`w-14 shrink-0 truncate text-xs font-medium ${failed() ? "text-berry" : "text-ink"}`}>{kind()}</Text>
        <Text class={`min-w-0 flex-1 truncate font-mono text-xs ${failed() ? "text-berry" : "text-muted"}`}>{farm() ?? props.step.text}</Text>
        <View accessibilityLabel={state()} tooltip={<Bubble text={state()} />} class="h-4 w-4 shrink-0 items-center justify-center">
          <If when={!running()} else={<Dot tone="water" size={6} ring={false} />}>
            <Icon name={props.step.ok === true ? "check" : "cross"} size={12} label={state()} />
          </If>
        </View>
        <When at={props.step.time} now={props.now} />
      </View>
      <If when={open()}>
        <View class="gap-1.5 pt-1.5 pr-2 pb-2 pl-7.5">
          <View class="flex-row items-center gap-2">
            <If when={props.step.tool}>
              <Text class="font-mono text-xs text-muted">{t("web.session.log.tool", { name: props.step.tool ?? "" })}</Text>
            </If>
            <View class={`rounded-sm px-1.5 py-px ${badgeClass()}`} style={running() ? { backgroundColor: mix("water", 0.14) } : undefined}>
              <Text class={`text-2xs font-medium ${badgeText()}`}>{state()}</Text>
            </View>
          </View>
          <If when={input()}>
            {(text) => (
              <View class="gap-1">
                <View class="flex-row items-center justify-between gap-2">
                  <Text class="text-2xs font-medium text-muted">{t("web.session.trajectory.input")}</Text>
                  <WorkLogCopyButton testID="worklog-copy-input" copied={copiedSlot() === "input"} onCopy={() => copyPayload("input", text())} />
                </View>
                <Scroll class="max-h-40 rounded-md border border-line bg-code-bg px-2.5 py-2">
                  <Text class="font-mono text-xs text-code-ink select-text">{text()}</Text>
                </Scroll>
              </View>
            )}
          </If>
          <View class="flex-row items-center justify-between gap-2">
            <Text class="text-2xs font-medium text-muted">{t("web.session.trajectory.output")}</Text>
            <If when={props.step.output}>
              {(out) => <WorkLogCopyButton testID="worklog-copy-output" copied={copiedSlot() === "output"} onCopy={() => copyPayload("output", out())} />}
            </If>
          </View>
          <If
            when={props.step.output}
            else={<Text class="text-xs text-faint">{running() ? t("web.session.log.pending") : t("web.session.log.noOutput")}</Text>}
          >
            {(out) => (
              <Scroll
                class={`rounded-md border px-2.5 py-2 ${failed() ? "bg-bad-soft" : "border-line bg-side"}`}
                style={failed() ? { maxHeight: 224, borderColor: mix("berry", 0.3) } : { maxHeight: 224 }}
              >
                <Text class={`font-mono text-xs select-text ${failed() ? "text-berry" : "text-ink"}`}>{out()}</Text>
              </Scroll>
            )}
          </If>
        </View>
      </If>
    </View>
  );
}
