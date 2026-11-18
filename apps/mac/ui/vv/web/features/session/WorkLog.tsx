// Ported from VibeValley apps/web/src/features/session/WorkLog.tsx: a
// session's steps by run, and the folded run under a report. The log's
// height (CSS --log-height, 22rem) is the `height` prop; a long text is cut
// at its lines without the fading mask.
import { Scroll, signal, Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import type { SessionEvent } from "@vibevalley/protocol";

import { useNow } from "../../base/dom";
import { ago, tookText } from "../../base/format";
import { Icon } from "../../ui/Icon";
import { actionIcon, type IconName } from "../../ui/icons";
import { Markdown } from "../../ui/Markdown";
import { Bubble } from "../../ui/Tip";
import { mix } from "../../ui/tone";
import { createSessionEvents } from "./events";
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
  spanColor,
  spanLabel,
  spansOf,
} from "./runs";

/** Under a report or the orchestrator's answer: the run behind it, folded to one line until opened. */
export function RunSteps(props: { session: string; run: string | undefined; orchestrator?: boolean }) {
  const open = signal(false);
  const all = createSessionEvents(
    () => props.session,
    () => !!props.run,
  );
  const steps = () => all().filter((e) => e.run === props.run);
  const label = () => (props.run ? runLabel(steps(), props.orchestrator ?? false) : undefined);
  const now = useNow();
  return (
    <If when={label()}>
      {(text) => (
        <View class="mt-1.5">
          <View
            role="button"
            testID="run-steps"
            onPress={() => open.set(!open())}
            accessibilityState={{ expanded: open() }}
            class="flex-row items-center gap-1.5 self-start rounded-md px-1.5 py-0.5 hover:bg-hover"
          >
            <Icon name="log" size={14} tone="muted" />
            <Text class="text-xs font-medium text-muted">{text()}</Text>
            <View style={{ opacity: 0.6 }}>
              <Icon name={open() ? "collapse" : "enlarge"} size={10} tone="muted" />
            </View>
          </View>
          <If when={open()}>
            <WorkLog steps={steps()} now={now()} asked={t("web.session.log.heard")} class="mt-1.5" />
          </If>
        </View>
      )}
    </If>
  );
}

/** A session's steps by run, each run folded to its answer but the last. Its height stops at 22rem, or at `height`. */
export function WorkLog(props: { steps: SessionEvent[]; now: number; asked?: string; working?: boolean; class?: string | undefined; height?: number }) {
  const shown = () => shownEvents(props.steps);
  const runs = () => runsOf(shown());
  const firstAsked = () => shown().find((s) => s.type === "user/message" && s.under === undefined)?.seq;
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
  const open = () => toggled() ?? props.last;
  const end = () => (props.live ? props.now : (lastTime(props.run) ?? props.now));
  const shown = () => {
    const answer = answerOf(props.run);
    return open() ? props.run.steps : answer ? [answer] : [];
  };
  return (
    <View testID="run" class={`gap-1.5 px-2 pt-2 pb-2.5 ${props.last ? "" : "border-b border-line"}`}>
      <View
        role="button"
        testID="run-fold"
        onPress={() => toggled.set(!open())}
        accessibilityLabel={open() ? t("web.session.log.fold") : t("web.session.log.unfold")}
        class="flex-row items-center gap-2 rounded-md px-1.5 py-1 hover:bg-hover"
      >
        <View style={{ transform: [{ rotate: open() ? "90deg" : "0deg" }] }}>
          <Icon name="expand" size={12} tone="muted" />
        </View>
        <Text class="text-sm font-semibold text-ink">{props.label}</Text>
        <Text class="min-w-0 flex-1 truncate text-xs text-muted">
          {`${t("web.session.log.steps", { n: props.run.steps.length, took: tookText(runMs(props.run, end())) })}${props.live ? t("web.session.log.live") : ""}`}
        </Text>
        <If when={props.run.asked}>{(asked) => <When at={asked().time} now={props.now} />}</If>
      </View>
      <If when={props.run.asked}>
        {(asked) => (
          <View class="rounded-md px-3 py-2" style={{ backgroundColor: mix("wheat", 0.15) }}>
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
            <Step step={s()} now={props.now} />
          </View>
        )}
      </Each>
      <If when={!open() && props.run.steps.length > shown().length}>
        <View role="button" testID="run-see" onPress={() => toggled.set(true)} class="self-start pl-1.5">
          <Text class="text-sm text-water">{t("web.session.log.see", { n: props.run.steps.length })}</Text>
        </View>
      </If>
    </View>
  );
}

function TimeBar(props: { run: RunView; end: number }) {
  const spans = () => spansOf(props.run, props.end);
  // The shortest span still shows: at least 1/80 of the bar.
  const least = () => {
    const total = spans().reduce((n, s) => n + s.ms, 0);
    return total <= 0 ? 1 : total / 80;
  };
  return (
    <View testID="time-bar" class="h-2 flex-row gap-px overflow-hidden rounded-xs">
      <Each of={spans()} key={(s) => s.step.seq}>
        {(s) => (
          <View
            tooltip={<Bubble text={`${spanLabel(s().step)} · ${tookText(s().ms)}\n${s().step.text.split("\n")[0]}`} />}
            style={{ flexGrow: Math.max(1, Math.round((Math.max(s().ms, least()) / least()) * 10)), flexBasis: 0, backgroundColor: spanColor(s().step) }}
          />
        )}
      </Each>
    </View>
  );
}

function When(props: { at: number; now: number }) {
  return <Text class="shrink-0 text-xs text-muted">{ago(props.at, props.now)}</Text>;
}

function Folded(props: { text: string; lines: number; markdown?: boolean }) {
  const open = signal(false);
  const long = () => isLongText(props.text, props.lines);
  const clamp = () => long() && !open();
  return (
    <View class="items-start">
      <View class="w-full overflow-hidden" style={clamp() ? { maxHeight: props.lines * 22 } : undefined}>
        {props.markdown === true ? <Markdown text={props.text} /> : <Text class="text-base text-ink">{props.text}</Text>}
      </View>
      <If when={long()}>
        <View role="button" onPress={() => open.set(!open())} class="mt-1">
          <Text class="text-sm text-water">{open() ? t("web.session.log.less") : t("web.session.log.all")}</Text>
        </View>
      </If>
    </View>
  );
}

function Box(props: { tint?: string; edge?: boolean; faint?: boolean; label: string; step: SessionEvent; now: number; children: JSX.Element }) {
  return (
    <View
      testID="step"
      class={`rounded-md px-3 py-2 ${props.edge === true ? "border border-line" : ""}`}
      style={[props.tint ? { backgroundColor: props.tint } : {}, props.faint === true ? { opacity: 0.85 } : {}]}
    >
      <View class="mb-1 flex-row items-center">
        <Text class={`text-xs font-semibold text-muted ${props.faint === true ? "italic" : ""}`}>{props.label}</Text>
        <View class="flex-1" />
        <When at={props.step.time} now={props.now} />
      </View>
      {props.children}
    </View>
  );
}

function Line(props: { mark: IconName; step: SessionEvent; now: number; tint: string; ink: string }) {
  return (
    <View testID="step" class="flex-row items-start gap-2 rounded-md px-3 py-1.5" style={{ backgroundColor: props.tint }}>
      <View class="mt-1">
        <Icon name={props.mark} size={12} tone={props.ink} />
      </View>
      <Text class={`min-w-0 flex-1 text-sm text-${props.ink}`}>{props.step.text}</Text>
      <When at={props.step.time} now={props.now} />
    </View>
  );
}

function Step(props: { step: SessionEvent; now: number }) {
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
        <Box edge faint label={sub() ? t("web.session.log.subagentThought") : t("web.session.log.thought")} step={props.step} now={props.now}>
          <Folded text={props.step.text} lines={2} />
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
        <Line mark="retry" step={props.step} now={props.now} tint={mix("wheat", 0.12)} ink="ink" />
      </If>
      <If when={type() === "llm/usage"}>
        <Line mark="spend" step={props.step} now={props.now} tint={mix("wheat", 0.06)} ink="muted" />
      </If>
      <If when={type() === "run/error"}>
        <Line mark="warn" step={props.step} now={props.now} tint={mix("berry", 0.1)} ink="berry" />
      </If>
    </>
  );
}

function ToolStep(props: { step: SessionEvent; now: number }) {
  const open = signal(false);
  const farm = () => farmToolText(props.step.text);
  const kind = () => (farm() ? t("web.session.log.farm") : (props.step.actionText ?? ""));
  const input = () => readableInput(props.step);
  const state = () => (props.step.ok === undefined ? t("web.session.log.running") : props.step.ok ? t("web.session.log.ok") : t("web.session.log.failed"));
  return (
    <View testID="step">
      <View
        role="button"
        testID="tool-step"
        onPress={() => open.set(!open())}
        accessibilityState={{ expanded: open() }}
        class={`w-full flex-row items-center gap-2 rounded-md px-2 py-1 ${open() ? "bg-hover" : "hover:bg-hover"}`}
      >
        <Icon name={actionIcon[props.step.action ?? "other"]} size={16} tone="ink" />
        <Text class="w-16 shrink-0 truncate text-sm font-medium text-ink">{kind()}</Text>
        <Text class="min-w-0 flex-1 truncate font-mono text-xs text-muted">{farm() ?? props.step.text}</Text>
        <View accessibilityLabel={state()} class="shrink-0">
          <If when={props.step.ok !== undefined} else={<Text class="text-xs text-faint">…</Text>}>
            <Icon name={props.step.ok === true ? "check" : "cross"} size={12} label={state()} />
          </If>
        </View>
        <When at={props.step.time} now={props.now} />
      </View>
      <If when={open()}>
        <View class="gap-1.5 pt-1 pr-2 pb-2 pl-8">
          <If when={props.step.tool}>
            <Text class="text-xs text-muted">{t("web.session.log.tool", { name: props.step.tool ?? "" })}</Text>
          </If>
          <If when={input()}>
            {(text) => (
              <Scroll class="rounded-md bg-code-bg px-2.5 py-2" style={{ maxHeight: 160 }}>
                <Text class="font-mono text-xs text-code-ink" style={{ userSelect: "text" }}>
                  {text()}
                </Text>
              </Scroll>
            )}
          </If>
          <If
            when={props.step.output}
            else={<Text class="text-xs text-muted">{props.step.ok === undefined ? t("web.session.log.pending") : t("web.session.log.noOutput")}</Text>}
          >
            {(out) => (
              <Scroll class="rounded-md bg-hover px-2.5 py-2" style={{ maxHeight: 224 }}>
                <Text class="font-mono text-xs text-ink" style={{ userSelect: "text" }}>
                  {out()}
                </Text>
              </Scroll>
            )}
          </If>
        </View>
      </If>
    </View>
  );
}
