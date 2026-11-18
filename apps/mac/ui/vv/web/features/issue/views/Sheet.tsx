// Ported from VibeValley apps/web/src/features/issue/views/Sheet.tsx: the
// same parts. The sheet's @container query (side beside the main column
// from 760px) is the sheet's own width read with onLayout; the fold's
// arrow turns without its 180ms rotation.
import { signal, Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";

import { Select } from "../../../ui/Field";
import { Icon } from "../../../ui/Icon";
import { mix } from "../../../ui/tone";
import type { Tone } from "../model/cards";
import { type Stage, stageLabel, stages } from "../model/issue";

/** A string or number child as words in `class`; anything else as it is. */
function Say(props: { children?: JSX.Element; class?: string }) {
  return (
    <If when={typeof props.children === "string" || typeof props.children === "number"} else={props.children}>
      <Text class={props.class ?? "text-sm text-ink"}>{props.children as string}</Text>
    </If>
  );
}

/** The width a view is laid out at, for what CSS did with a container query. */
export function useWidth() {
  const width = signal(0);
  return { width, onLayout: (e: { bounds: { size: { width: number } } }) => width.set(e.bounds.size.width) };
}

/** An issue laid out as a page: what it is and the talk about it on the left, its properties and actions on the right. */
export function IssueSheet(props: { heading: JSX.Element; main: JSX.Element; side: JSX.Element }) {
  const box = useWidth();
  // Until it is laid out it is taken as wide: the page is wide far more often.
  const wide = () => box.width() === 0 || box.width() >= 760;
  return (
    <View onLayout={box.onLayout}>
      {props.heading}
      <View class={wide() ? "mt-4 flex-row items-start gap-6" : "mt-4 gap-4"}>
        <View class="min-w-0 flex-1">{props.main}</View>
        <View class={wide() ? "w-65 shrink-0 border-l border-line pl-5" : "rounded-lg bg-hover p-3"}>{props.side}</View>
      </View>
    </View>
  );
}

/** A label and its value, the label in a narrow muted column. */
export function Property(props: { label: string; children: JSX.Element }) {
  return (
    <View class="min-h-8 flex-row items-center gap-3 py-0.5">
      <Text class="w-16 shrink-0 text-sm text-muted">{props.label}</Text>
      <View class="min-w-0 flex-1">
        <Say>{props.children}</Say>
      </View>
    </View>
  );
}

/** A second-level part: folded until asked for, its summary beside the label. */
export function Fold(props: {
  label: string;
  summary?: string | undefined;
  open?: boolean;
  leading?: JSX.Element;
  testID?: string;
  onToggle?: (open: boolean) => void;
  children: JSX.Element;
}) {
  const open = signal(props.open ?? false);
  const toggle = () => {
    open.set(!open());
    props.onToggle?.(open());
  };
  return (
    <View class="border-b border-line">
      <View
        role="button"
        testID={props.testID}
        accessibilityState={{ expanded: open() }}
        onPress={toggle}
        class="w-full flex-row items-center gap-2 py-2.5 hover:bg-hover"
      >
        <View style={{ transform: [{ rotate: open() ? "90deg" : "0deg" }] }}>
          <Icon name="expand" size={10} tone="muted" />
        </View>
        {props.leading}
        <Text class="shrink-0 text-sm font-semibold text-ink">{props.label}</Text>
        <If when={props.summary}>
          <Text class="min-w-0 truncate text-xs text-muted">{props.summary}</Text>
        </If>
      </View>
      <If when={open()}>
        <View class="pb-3 pl-5">{props.children}</View>
      </If>
    </View>
  );
}

/** The properties asked about less often, behind More. */
export function More(props: { children: JSX.Element }) {
  const open = signal(false);
  return (
    <View class="mt-1">
      <View role="button" testID="sheet-more" onPress={() => open.set(!open())} class="flex-row items-center gap-1.5 self-start py-1">
        <View style={{ transform: [{ rotate: open() ? "90deg" : "0deg" }] }}>
          <Icon name="expand" size={10} tone="muted" />
        </View>
        <Text class="text-xs text-muted">{open() ? t("web.issue.sheet.less") : t("web.issue.sheet.more")}</Text>
      </View>
      <If when={open()}>
        <View class="mt-1">{props.children}</View>
      </If>
    </View>
  );
}

export function SheetLabel(props: { children: JSX.Element }) {
  return (
    <View class="mt-6 mb-1.5 flex-row items-baseline">
      <Say class="text-xs font-semibold text-muted">{props.children}</Say>
    </View>
  );
}

/** A tinted box: the status, a conflict, nothing to merge. */
export function Note(props: { tone?: Tone | undefined; children: JSX.Element; class?: string | undefined }) {
  return (
    <View
      class={`rounded-lg px-3.5 py-3 ${props.tone ? "" : "bg-hover"} ${props.class ?? ""}`}
      style={props.tone ? { backgroundColor: mix(props.tone, 0.16) } : undefined}
    >
      <Say>{props.children}</Say>
    </View>
  );
}

/** Draft -> Active -> Done, the one it is at marked. */
export function Stages(props: { at: Stage }) {
  const ati = () => stages.indexOf(props.at);
  return (
    <View class="flex-row items-center" accessibilityLabel={t("web.issue.sheet.at", { stage: stageLabel[props.at] })}>
      <Each of={stages}>
        {(s, i) => (
          <View class={`flex-row items-center ${i() > 0 ? "flex-1" : ""}`}>
            <If when={i() > 0}>
              <View class={`mx-2 h-px flex-1 ${i() <= ati() ? "bg-leaf" : "bg-line"}`} />
            </If>
            <View class="flex-row items-center gap-1.5">
              <If when={i() < ati()} else={<View class={`h-2 w-2 rounded-full ${s() === props.at ? "bg-wheat" : "bg-line"}`} />}>
                <Icon name="check" size={12} label={t("web.issue.sheet.stageDone", { stage: stageLabel[s()] })} />
              </If>
              <Text class={`text-sm ${s() === props.at ? "font-semibold text-ink" : i() < ati() ? "text-accent" : "text-faint"}`}>{stageLabel[s()]}</Text>
            </View>
          </View>
        )}
      </Each>
    </View>
  );
}

export function Pick<V extends string>(props: {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  placeholder?: ("" extends V ? string : never) | undefined;
  onChange: (v: V) => void;
  disabled?: boolean;
  testid?: string;
  state?: "pending" | "failed" | undefined;
}) {
  return (
    <Select
      quiet
      size="control"
      class="-ml-2"
      label={props.label}
      value={props.value}
      options={props.options}
      placeholder={props.placeholder}
      onChange={props.onChange}
      disabled={props.disabled}
      testid={props.testid}
      state={props.state}
    />
  );
}
