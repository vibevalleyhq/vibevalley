// Ported from VibeValley apps/web/src/features/issue/views/Sheet.tsx: the
// same parts. Wide layouts split into an independently scrollable main column
// and a fixed right inspector; narrow layouts collapse the inspector into a
// right slide-over drawer controlled from IssueView's top bar.
import { context, effect, Scroll, signal, Text, untracked, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";

import { Select } from "../../../ui/Field";
import { Icon } from "../../../ui/Icon";
import { IconButton } from "../../../ui/IconButton";
import { mix } from "../../../ui/tone";
import type { Tone } from "../model/cards";
import { type Stage, stageLabel, stages } from "../model/issue";

export interface IssueChrome {
  readonly hasSheet: () => boolean;
  readonly wide: () => boolean;
  readonly desktopOpen: () => boolean;
  readonly drawerOpen: () => boolean;
  readonly inspectorVisible: () => boolean;
  readonly mountSheet: () => void;
  readonly unmountSheet: () => void;
  readonly setWide: (on: boolean) => void;
  readonly toggleInspector: () => void;
  readonly closeDrawer: () => void;
}

export const IssueChromeContext = context<IssueChrome | undefined>(undefined);

/** Coordinates the top-bar inspector toggle in IssueView with IssueSheet's desktop/drawer split. */
export function createIssueChrome(): IssueChrome {
  const sheetCount = signal(0);
  const wide = signal(true);
  const desktopOpen = signal(true);
  const drawerOpen = signal(false);
  return {
    hasSheet: () => sheetCount() > 0,
    wide,
    desktopOpen,
    drawerOpen,
    inspectorVisible: () => (wide() ? desktopOpen() : drawerOpen()),
    mountSheet: () => sheetCount.set(untracked(sheetCount) + 1),
    unmountSheet: () => sheetCount.set(Math.max(0, untracked(sheetCount) - 1)),
    setWide: (on) => {
      if (untracked(wide) !== on) wide.set(on);
      if (on && untracked(drawerOpen)) drawerOpen.set(false);
    },
    toggleInspector: () => {
      if (untracked(wide)) desktopOpen.set(!untracked(desktopOpen));
      else drawerOpen.set(!untracked(drawerOpen));
    },
    closeDrawer: () => {
      if (untracked(drawerOpen)) drawerOpen.set(false);
    },
  };
}

/** A string or number child as words in `class`; anything else as it is. */
function Say(props: { children?: JSX.Element; class?: string }) {
  return (
    <If when={typeof props.children === "string" || typeof props.children === "number"} else={props.children}>
      <Text class={props.class ?? "text-sm text-ink"}>{props.children}</Text>
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
  const chrome = IssueChromeContext();
  const box = useWidth();
  // Until it is laid out it is taken as wide: the page is wide far more often.
  const wide = () => box.width() === 0 || box.width() >= 760;
  effect(() => {
    if (!chrome) return;
    chrome.mountSheet();
    return () => chrome.unmountSheet();
  });
  effect(() => {
    chrome?.setWide(wide());
  });
  const desktopOpen = () => (chrome ? chrome.desktopOpen() : true);
  const drawerOpen = () => (chrome ? chrome.drawerOpen() : false);
  return (
    <View onLayout={box.onLayout} class="relative min-h-0 flex-1 flex-row">
      <Scroll testID="issue-scroll" class="min-h-0 min-w-0 flex-1">
        <View class={`w-full max-w-200 self-center ${wide() ? "px-6 pt-5 pb-12" : "px-4 pt-4 pb-10"}`}>
          {props.heading}
          <View class="mt-5">{props.main}</View>
        </View>
      </Scroll>
      <If when={wide() && desktopOpen()}>
        <View testID="issue-inspector" class="min-h-0 w-72 shrink-0 border-l border-line bg-side">
          <Scroll class="min-h-0 flex-1">
            <View class="px-4 pt-4 pb-8">{props.side}</View>
          </Scroll>
        </View>
      </If>
      <If when={!wide() && drawerOpen()}>
        <View testID="issue-inspector-backdrop" class="absolute inset-0 z-20 bg-scrim" onPress={() => chrome?.closeDrawer()} />
        <View testID="issue-inspector" class="absolute top-0 right-0 bottom-0 z-30 w-72 max-w-full border-l border-line bg-side shadow-float">
          <View class="h-10 shrink-0 flex-row items-center justify-between border-b border-line px-4">
            <Text class="text-xs font-semibold text-muted">{t("web.issue.detail.properties")}</Text>
            <IconButton icon="close" size={14} label={t("web.issue.sheet.less")} onClick={() => chrome?.closeDrawer()} />
          </View>
          <Scroll class="min-h-0 flex-1">
            <View class="px-4 pt-3 pb-8">{props.side}</View>
          </Scroll>
        </View>
      </If>
    </View>
  );
}

/** A label and its value, the label in a narrow muted column. */
export function Property(props: { label: string; align?: "center" | "start"; children: JSX.Element }) {
  const start = () => props.align === "start";
  return (
    <View class={`min-h-7.5 flex-row gap-2.5 py-0.5 ${start() ? "items-start" : "items-center"}`}>
      <Text class={`w-16 shrink-0 text-xs text-muted ${start() ? "pt-1" : ""}`}>{props.label}</Text>
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
  defaultOpen?: boolean;
  leading?: JSX.Element;
  aside?: JSX.Element;
  testID?: string;
  onToggle?: (open: boolean) => void;
  children: JSX.Element;
}) {
  const localOpen = signal(props.defaultOpen ?? false);
  const open = () => props.open ?? localOpen();
  const toggle = () => {
    const next = !open();
    if (props.open === undefined) localOpen.set(next);
    props.onToggle?.(next);
  };
  return (
    <View class="border-b border-line">
      <View class="flex-row items-center gap-2">
        <View
          role="button"
          testID={props.testID}
          accessibilityState={{ expanded: open() }}
          onPress={toggle}
          class="-mx-2 min-w-0 flex-1 flex-row items-center gap-2 rounded-md px-2 py-2.5 transition duration-120 ease-out hover:bg-hover"
        >
          <View class="size-3.5 shrink-0 items-center justify-center" style={{ transform: [{ rotate: open() ? "90deg" : "0deg" }] }}>
            <Icon name="expand" size={10} tone="muted" />
          </View>
          {props.leading}
          <Text class="shrink-0 text-sm font-semibold text-ink">{props.label}</Text>
          <If when={props.summary}>
            <Text class="min-w-0 truncate text-xs text-muted tabular-nums">{props.summary}</Text>
          </If>
        </View>
        {props.aside}
      </View>
      <If when={open()}>
        <View class="pb-3 pl-5.5">{props.children}</View>
      </If>
    </View>
  );
}

/** The properties asked about less often, behind More. */
export function More(props: { children: JSX.Element }) {
  const open = signal(false);
  return (
    <View class="mt-2">
      <View
        role="button"
        testID="sheet-more"
        onPress={() => open.set(!open())}
        class="-mx-1.5 flex-row items-center gap-1.5 self-start rounded-md px-1.5 py-1 transition duration-120 ease-out hover:bg-hover"
      >
        <View class="size-3.5 shrink-0 items-center justify-center" style={{ transform: [{ rotate: open() ? "90deg" : "0deg" }] }}>
          <Icon name="expand" size={10} tone="muted" />
        </View>
        <Text class="text-xs font-medium text-muted">{open() ? t("web.issue.sheet.less") : t("web.issue.sheet.more")}</Text>
      </View>
      <If when={open()}>
        <View class="mt-1">{props.children}</View>
      </If>
    </View>
  );
}

export function SheetLabel(props: { first?: boolean; divider?: boolean; children: JSX.Element }) {
  const chrome = IssueChromeContext();
  // Narrow drawer already renders a sticky Properties header above `side`; suppress the duplicate leading Properties label there.
  const duplicateDrawerHeading = () => props.first === true && chrome !== undefined && !chrome.wide() && props.children === t("web.issue.detail.properties");
  const spacing = () => (props.first === true ? "mt-0 mb-2" : props.divider === true ? "mt-4 mb-2 border-t border-line pt-4" : "mt-6 mb-2");
  return (
    <If when={!duplicateDrawerHeading()}>
      <View class={`${spacing()} flex-row items-baseline`}>
        <Say class="text-xs font-semibold text-muted">{props.children}</Say>
      </View>
    </If>
  );
}

/** A tinted box: the status, a conflict, nothing to merge. */
export function Note(props: { tone?: Tone | undefined; children: JSX.Element; class?: string | undefined }) {
  return (
    <View
      class={`rounded-lg px-3.5 py-3 ${props.tone ? "" : "bg-hover"} ${props.class ?? ""}`}
      style={props.tone ? { backgroundColor: mix(props.tone, 0.14) } : undefined}
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
  const shown = () => props.options.find((o) => o.value === props.value)?.label ?? props.placeholder ?? "";
  return (
    <If
      when={props.disabled === true}
      else={
        <Select
          quiet
          size="control"
          class="-ml-2"
          label={props.label}
          value={props.value}
          options={props.options}
          placeholder={props.placeholder}
          onChange={props.onChange}
          testid={props.testid}
          state={props.state}
        />
      }
    >
      <View testID={props.testid} accessibilityLabel={props.label} class="min-h-7 flex-row items-center">
        <Text class={`min-w-0 truncate text-sm ${props.value === "" ? "text-faint" : "text-ink"}`}>{shown()}</Text>
      </View>
    </If>
  );
}
