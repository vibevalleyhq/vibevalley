import { Clipboard, Scroll, signal, Text, View, type ViewRef } from "nsh";

import { t } from "@vibevalley/i18n";
import type { SessionEvent } from "@vibevalley/protocol";
import { oneLine } from "@vibevalley/protocol/rules";

import { ButtonLink } from "../../../design/Button";
import { Icon } from "../../../design/Icon";
import { Markdown } from "../../../design/Markdown";
import { motionClass } from "../../../design/motion";
import { Dot } from "../../../design/Tag";
import { Bubble } from "../../../design/Tip";
import { toast } from "../../../design/toasts";
import { mix } from "../../../design/tone";
import { useTimeout } from "../../../infra/base/timer";
import { localizeRuntimeError } from "../../../infra/runtimeError";
import { createEffect, createMemo } from "../../../infra/solid";
import { collapsedStepSummary, farmToolText, localizeCollapsedSummary, readableInput, secondsText } from "../runs";
import { compactTokenBadge, type RowSpec, stepTextOf, tagToneOf } from "./model";

export function Row(props: { spec: RowSpec; open: boolean; marked: boolean; refTo: (el: ViewRef) => void; onToggle: () => void }) {
  const step = () => props.spec.step;
  const tagTone = createMemo(() => tagToneOf(step()));
  const tool = () => step().type === "tool/call";
  const running = () => tool() && step().ok === undefined;
  const failed = () => (tool() && step().ok === false) || step().type === "run/error";
  const sub = () => step().under !== undefined;
  const bodyText = createMemo(() => stepTextOf(step()));
  const summaryLine = createMemo(() => {
    const pre = props.spec.collapsedSummary;
    if (pre !== undefined) return localizeCollapsedSummary(pre);
    return collapsedStepSummary(step(), bodyText());
  });
  const durationLabel = () => {
    const ms = props.spec.durationMs;
    return ms !== undefined && ms >= 100 ? secondsText(ms) : undefined;
  };
  const tokenLabel = () => (step().type === "llm/usage" ? compactTokenBadge(step()) : undefined);
  return (
    <View ref={(el) => props.refTo(el)} testID="step">
      <View
        role="button"
        testID={`step-toggle-${String(step().seq)}`}
        accessibilityLabel={`${props.spec.tag} ${summaryLine()}`}
        accessibilityState={{ expanded: props.open }}
        onPress={() => props.onToggle()}
        class={`group w-full flex-row items-center gap-2 px-3 py-1.5 focus-visible:outline-2 focus-visible:outline-focus ${
          props.marked ? "" : props.open ? "bg-selected" : "hover:bg-hover"
        }`}
        style={props.marked ? { backgroundColor: mix("wheat", 0.25) } : undefined}
      >
        <View
          class={`h-3.5 w-3.5 shrink-0 items-center justify-center ${motionClass("transition-transform duration-120 ease-out")}`}
          style={{ transform: [{ rotate: props.open ? "90deg" : "0deg" }] }}
        >
          <Icon name="expand" size={10} tone={props.open ? "ink" : "muted"} />
        </View>
        <View
          class={`shrink-0 rounded-sm px-1.5 py-px ${sub() ? "ml-2 w-14 border-l-2" : "w-16"} ${tagTone().bgClass}`}
          style={(() => {
            const bg = tagTone().bgStyle;
            const border = sub() ? { borderColor: mix("leaf", 0.65) } : undefined;
            return bg || border ? { ...(bg ? { backgroundColor: bg() } : {}), ...border } : undefined;
          })()}
        >
          <Text class={`truncate text-center text-2xs font-medium ${tagTone().text}`}>{props.spec.tag}</Text>
        </View>
        <View class="min-w-0 flex-1">
          <If
            when={tool()}
            else={
              <Text class={`truncate text-sm ${failed() ? "text-berry" : step().type === "llm/usage" ? "text-muted tabular-nums" : "text-ink"}`}>
                {summaryLine()}
              </Text>
            }
          >
            <ToolLine step={step()} failed={failed()} />
          </If>
        </View>
        <View class="shrink-0 flex-row items-center gap-1.5">
          <Text class={`text-2xs text-faint ${props.open ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
            {props.open ? t("web.session.trajectory.hideDetail") : t("web.session.trajectory.inspect")}
          </Text>
          <If when={durationLabel()}>{(dur) => <Text class="whitespace-nowrap font-mono text-2xs text-faint tabular-nums">{dur()}</Text>}</If>
          <If when={tokenLabel()}>{(tok) => <Text class="whitespace-nowrap font-mono text-2xs text-faint tabular-nums">{tok()}</Text>}</If>
          <If when={failed()}>
            <Icon name="cross" size={12} />
          </If>
          <If when={!failed() && running()}>
            <Dot tone="water" size={6} ring={false} />
          </If>
          <If when={!failed() && tool() && step().ok === true}>
            <Icon name="check" size={12} />
          </If>
          <If when={!failed() && step().type === "llm/retry"}>
            <Icon name="warn" size={12} />
          </If>
        </View>
        <Text testID={`step-when-${String(step().seq)}`} class="min-w-16 shrink-0 whitespace-nowrap text-right text-2xs text-faint tabular-nums">
          {props.spec.when}
        </Text>
      </View>
      <If when={props.open}>
        <StepDrawer step={step()} tag={props.spec.tag} body={bodyText()} durationMs={props.spec.durationMs} readableInput={props.spec.readableInput} />
      </If>
    </View>
  );
}

/** Structured inline inspection drawer opened underneath any trajectory step row. */
function StepDrawer(props: { step: SessionEvent; tag: string; body: string; durationMs: number | undefined; readableInput?: string | undefined }) {
  return (
    <View testID={`step-drawer-${String(props.step.seq)}`} class="border-t border-line py-2.5 pr-3.5 pl-8" style={{ backgroundColor: mix("side", 0.7) }}>
      <If
        when={props.step.type === "tool/call"}
        else={
          <If when={props.step.type === "run/error"} else={<BodyDetail step={props.step} tag={props.tag} body={props.body} durationMs={props.durationMs} />}>
            <ErrorDetail step={props.step} />
          </If>
        }
      >
        <ToolDetail step={props.step} durationMs={props.durationMs} readableInput={props.readableInput} />
      </If>
    </View>
  );
}

/** `what {args} → result`, the args and result in the code font. */
function ToolLine(props: { step: SessionEvent; failed: boolean }) {
  const args = () => oneLine(props.step.input ?? "").trim();
  const out = () => oneLine(props.step.output ?? "").trim();
  return (
    <Text class={`truncate text-sm ${props.failed ? "text-berry" : "text-ink"}`}>
      {farmToolText(props.step.text) ?? props.step.text}
      <If when={args()}>
        <Text class="font-mono text-xs text-muted">{` ${args()}`}</Text>
      </If>
      <Text class="text-faint">{" → "}</Text>
      <If when={props.step.ok !== undefined} else={<Text class="text-xs text-water">{t("web.session.trajectory.pending")}</Text>}>
        <If when={out()} else={<Text class="text-xs text-faint">{t("web.session.trajectory.noOutput")}</Text>}>
          <Text class={`font-mono text-xs ${props.step.ok === false ? "text-berry" : "text-muted"}`}>{out()}</Text>
        </If>
      </If>
    </Text>
  );
}

function CopyStepButton(props: { testID: string; copied: boolean; label?: string | undefined; onCopy: () => void }) {
  const text = () => (props.copied ? t("web.base.rich.copied") : (props.label ?? t("web.base.rich.copy")));
  return (
    <View
      role="button"
      testID={props.testID}
      accessibilityLabel={text()}
      tooltip={<Bubble text={text()} />}
      onPress={props.onCopy}
      class="flex-row items-center gap-1 rounded-sm px-1.5 py-0.5 focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover"
    >
      <Icon name={props.copied ? "check" : "copy"} size={12} tone={props.copied ? "leaf" : "muted"} />
      <Text class={`text-2xs ${props.copied ? "font-medium text-ok-ink" : "text-muted"}`}>{text()}</Text>
    </View>
  );
}

function ToolDetail(props: { step: SessionEvent; durationMs: number | undefined; readableInput?: string | undefined }) {
  const copiedSlot = signal<"input" | "output" | undefined>(undefined);
  const resetCopy = useTimeout();
  createEffect(
    () => props.step.seq,
    () => copiedSlot.set(undefined),
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
  const input = () => props.readableInput ?? readableInput(props.step);
  const running = () => props.step.ok === undefined;
  const failed = () => props.step.ok === false;
  const stateLabel = () =>
    running() ? t("web.session.trajectory.running") : props.step.ok === true ? t("web.session.trajectory.ok") : t("web.session.trajectory.failed");
  const badgeClass = () => (running() ? "" : failed() ? "bg-bad-soft" : "bg-ok-soft");
  const badgeText = () => (running() ? "text-water" : failed() ? "text-berry" : "text-ok-ink");
  const durationLabel = () => (props.durationMs !== undefined ? secondsText(props.durationMs) : undefined);
  return (
    <View class="gap-2">
      <View class="flex-row items-center gap-2">
        <If when={props.step.tool}>
          <Text class="font-mono text-xs font-medium text-ink">{t("web.session.trajectory.tool", { name: props.step.tool ?? "" })}</Text>
        </If>
        <View
          testID="tool-status-badge"
          class={`rounded-sm px-1.5 py-px ${badgeClass()}`}
          style={running() ? { backgroundColor: mix("water", 0.14) } : undefined}
        >
          <Text class={`text-2xs font-medium ${badgeText()}`}>{stateLabel()}</Text>
        </View>
        <If when={durationLabel()}>
          {(dur) => (
            <Text testID="tool-duration" class="font-mono text-2xs text-muted tabular-nums">
              {dur()}
            </Text>
          )}
        </If>
      </View>
      <If when={input()}>
        {(text) => (
          <View class="gap-1">
            <View class="flex-row items-center justify-between gap-2">
              <Text class="text-2xs font-medium text-muted">{t("web.session.trajectory.input")}</Text>
              <CopyStepButton testID="tool-copy-input" copied={copiedSlot() === "input"} onCopy={() => copyPayload("input", text())} />
            </View>
            <Scroll class="max-h-40 rounded-md border border-line bg-code-bg px-2.5 py-2">
              <Text class="select-text font-mono text-xs text-code-ink">{text()}</Text>
            </Scroll>
          </View>
        )}
      </If>
      <View class="gap-1">
        <View class="flex-row items-center justify-between gap-2">
          <Text class="text-2xs font-medium text-muted">{t("web.session.trajectory.output")}</Text>
          <If when={props.step.output}>
            {(out) => <CopyStepButton testID="tool-copy-output" copied={copiedSlot() === "output"} onCopy={() => copyPayload("output", out())} />}
          </If>
        </View>
        <If
          when={props.step.output}
          else={<Text class="text-xs text-faint">{running() ? t("web.session.trajectory.pending") : t("web.session.trajectory.noOutput")}</Text>}
        >
          <Scroll
            class={`max-h-56 rounded-md border px-2.5 py-2 ${failed() ? "bg-bad-soft" : "border-line bg-page"}`}
            style={failed() ? { borderColor: mix("berry", 0.3) } : undefined}
          >
            <Text class={`select-text font-mono text-xs ${failed() ? "text-berry" : "text-ink"}`}>{props.step.output ?? ""}</Text>
          </Scroll>
        </If>
      </View>
    </View>
  );
}

function ErrorDetail(props: { step: SessionEvent }) {
  const copied = signal(false);
  const resetCopy = useTimeout();
  createEffect(
    () => props.step.seq,
    () => copied.set(false),
    { defer: true },
  );
  const localized = createMemo(() => localizeRuntimeError(props.step.text));
  const copyRaw = () => {
    void Clipboard.writeText(props.step.text).then(
      () => {
        copied.set(true);
        resetCopy(() => copied.set(false), 1500);
        toast(t("web.base.rich.copied"));
      },
      () => undefined,
    );
  };
  return (
    <View testID="error-callout" class="gap-2 rounded-md border bg-bad-soft px-3 py-2.5" style={{ borderColor: mix("berry", 0.3) }}>
      <View class="flex-row items-start gap-2">
        <View class="mt-0.5 shrink-0">
          <Icon name="cross" size={12} />
        </View>
        <Text class="min-w-0 flex-1 select-text text-sm text-berry">{localized().text}</Text>
      </View>
      <View class="flex-row items-center justify-end gap-2">
        <If when={localized().settingsHref}>
          {(href) => (
            <ButtonLink size="compact" href={href()} icon="settings" testID="error-open-settings">
              {t("web.session.trajectory.openSettings")}
            </ButtonLink>
          )}
        </If>
        <CopyStepButton testID="error-copy-raw" copied={copied()} label={t("web.session.trajectory.copyRawError")} onCopy={copyRaw} />
      </View>
    </View>
  );
}

function BodyDetail(props: { step: SessionEvent; tag: string; body: string; durationMs: number | undefined }) {
  const copied = signal(false);
  const resetCopy = useTimeout();
  createEffect(
    () => props.step.seq,
    () => copied.set(false),
    { defer: true },
  );
  const copyBody = () => {
    if (!props.body) return;
    void Clipboard.writeText(props.body).then(
      () => {
        copied.set(true);
        resetCopy(() => copied.set(false), 1500);
        toast(t("web.base.rich.copied"));
      },
      () => undefined,
    );
  };
  const durationLabel = () => (props.durationMs !== undefined && props.durationMs >= 100 ? secondsText(props.durationMs) : undefined);
  return (
    <View class="gap-1.5">
      <View class="flex-row items-center justify-between gap-2">
        <View class="flex-row items-center gap-2">
          <Text class="text-2xs font-medium text-muted">{props.tag}</Text>
          <If when={durationLabel()}>{(dur) => <Text class="font-mono text-2xs text-faint tabular-nums">{dur()}</Text>}</If>
        </View>
        <If when={props.body.length > 0}>
          <CopyStepButton testID="step-copy-body" copied={copied()} onCopy={copyBody} />
        </If>
      </View>
      <View class="rounded-md border border-line bg-page px-3 py-2">
        <If
          when={props.step.type === "assistant/message"}
          else={
            <Text
              class={`select-text ${
                props.step.type === "llm/usage"
                  ? "font-mono text-xs text-muted tabular-nums"
                  : props.step.type === "assistant/thinking"
                    ? "text-sm text-muted"
                    : "text-sm text-ink"
              }`}
            >
              {props.body}
            </Text>
          }
        >
          <Markdown size="sm" text={props.body} />
        </If>
      </View>
    </View>
  );
}
