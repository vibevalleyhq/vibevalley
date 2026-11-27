import { Clipboard, context, effect, Scroll, signal, Text, untracked, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import type { Issue } from "@vibevalley/protocol";

import { Select } from "../../../design/Field";
import { Icon } from "../../../design/Icon";
import { IconButton } from "../../../design/IconButton";
import { Dot } from "../../../design/Tag";
import { Bubble } from "../../../design/Tip";
import { toast } from "../../../design/toasts";
import { mix } from "../../../design/tone";
import { useTimeout } from "../../../infra/base/timer";
import { createEffect } from "../../../infra/solid";
import type { Tone } from "../model/cards";

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

/** One toggle shared by IssueView's top bar and the sheet's desktop/drawer split. */
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
        <View class={`w-full max-w-4xl self-center ${wide() ? "px-8 pt-6 pb-14" : "px-4 pt-4 pb-10"}`}>
          {props.heading}
          <View class="mt-6">{props.main}</View>
        </View>
      </Scroll>
      <If when={wide() && desktopOpen()}>
        <View testID="issue-inspector" class="h-full min-h-0 w-76 shrink-0 border-l border-line bg-side">
          <Scroll testID="issue-inspector-scroll" class="min-h-0 flex-1" contentClass="px-4 pt-4 pb-10">
            {props.side}
          </Scroll>
        </View>
      </If>
      <If when={!wide() && drawerOpen()}>
        <View testID="issue-inspector-backdrop" class="absolute inset-0 z-20 bg-scrim" onPress={() => chrome?.closeDrawer()} />
        <View testID="issue-inspector" class="absolute top-0 right-0 bottom-0 z-30 w-76 max-w-full border-l border-line bg-side shadow-float">
          <View class="h-10 shrink-0 flex-row items-center justify-between border-b border-line px-4">
            <Text class="text-xs font-semibold text-muted">{t("web.issue.detail.properties")}</Text>
            <IconButton icon="close" size={14} label={t("web.issue.sheet.less")} onClick={() => chrome?.closeDrawer()} />
          </View>
          <Scroll testID="issue-inspector-scroll" class="min-h-0 flex-1" contentClass="px-4 pt-3 pb-10">
            {props.side}
          </Scroll>
        </View>
      </If>
    </View>
  );
}

/** A label and its value, the label in a narrow muted column. */
export function Property(props: { label: string; icon?: JSX.Element; align?: "center" | "start"; inset?: boolean; children: JSX.Element }) {
  const start = () => props.align === "start";
  return (
    <View class={`min-h-8 flex-row gap-2 py-0.5 ${start() ? "items-start" : "items-center"}`}>
      <Text class={`w-18 shrink-0 text-xs text-muted ${start() ? "pt-1.5" : ""}`}>{props.label}</Text>
      <View class={`min-w-0 flex-1 flex-row gap-1 ${start() ? "items-start" : "items-center"}`}>
        <If when={props.icon}>
          <View class={`w-4 shrink-0 items-center justify-center ${start() ? "pt-1.5" : ""}`}>{props.icon}</View>
        </If>
        <View class={`min-w-0 flex-1 ${props.inset === true ? "" : "px-2"}`}>
          <Say>{props.children}</Say>
        </View>
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
  bordered?: boolean;
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
    <View class={props.bordered === false ? "" : "border-b border-line"}>
      <View class="flex-row items-center gap-2">
        <View
          role="button"
          testID={props.testID}
          accessibilityState={{ expanded: open() }}
          onPress={toggle}
          class="-mx-2 min-w-0 flex-1 flex-row items-center gap-2 rounded-md px-2 py-2.5 hover:bg-hover"
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
        class="-mx-1.5 flex-row items-center gap-1.5 self-start rounded-md px-1.5 py-1 hover:bg-hover"
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
  const spacing = () => (props.first === true ? "mt-0 mb-2.5" : props.divider === true ? "mt-4 mb-2.5 border-t border-line pt-4" : "mt-6 mb-2.5");
  return (
    <If when={!duplicateDrawerHeading()}>
      <View class={`${spacing()} flex-row items-baseline`}>
        <Say class="text-xs font-semibold text-muted">{props.children}</Say>
      </View>
    </If>
  );
}

const stagePillStyles: Record<Tone, { bgClass: string; bgStyle?: () => string; textClass: string }> = {
  leaf: { bgClass: "bg-ok-soft", textClass: "text-ok-ink" },
  berry: { bgClass: "bg-bad-soft", textClass: "text-berry" },
  wheat: { bgClass: "bg-warn-soft", textClass: "text-warn-ink" },
  water: { bgClass: "", bgStyle: () => mix("water", 0.14), textClass: "text-water" },
  muted: { bgClass: "bg-hover", textClass: "text-muted" },
  faint: { bgClass: "bg-hover", textClass: "text-muted" },
};

/** Semantic stage badge: colored dot + stage label inside a soft rounded pill. */
export function StagePill(props: { tone: Tone; label: string }) {
  const look = () => stagePillStyles[props.tone];
  const bgStyle = () => {
    const bg = look().bgStyle;
    return bg ? { backgroundColor: bg() } : undefined;
  };
  return (
    <View class={`shrink-0 flex-row items-center gap-1.5 rounded-full px-2.5 py-0.5 ${look().bgClass}`} style={bgStyle()}>
      <Dot tone={props.tone} size={7} ring={false} />
      <Text class={`text-xs font-semibold ${look().textClass}`}>{props.label}</Text>
    </View>
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

export function Pick<V extends string>(props: {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  placeholder?: ("" extends V ? string : never) | undefined;
  onChange: (v: V) => void;
  disabled?: boolean;
  testid?: string;
  state?: "pending" | "failed" | undefined;
  searchable?: boolean | undefined;
  searchPlaceholder?: string | undefined;
  emptyText?: string | undefined;
}) {
  const shown = () => props.options.find((o) => o.value === props.value)?.label ?? props.placeholder ?? "";
  return (
    <If
      when={props.disabled === true}
      else={
        <Select
          quiet
          size="control"
          label={props.label}
          value={props.value}
          options={props.options}
          placeholder={props.placeholder}
          onChange={props.onChange}
          testid={props.testid}
          state={props.state}
          searchable={props.searchable}
          searchPlaceholder={props.searchPlaceholder}
          emptyText={props.emptyText}
        />
      }
    >
      <View testID={props.testid} accessibilityLabel={props.label} class="min-h-7 flex-row items-center px-2">
        <Text class={`min-w-0 truncate text-sm ${props.value === "" ? "text-faint" : "text-ink"}`}>{shown()}</Text>
      </View>
    </If>
  );
}

/** Clickable `#number` pill that copies the issue reference with transient check feedback. */
export function IssueNumberPill(props: { number: number }) {
  const copied = signal(false);
  const reset = useTimeout();
  createEffect(
    () => props.number,
    () => copied.set(false),
    { defer: true },
  );
  const copy = () => {
    void Clipboard.writeText(`#${props.number}`).then(
      () => {
        copied.set(true);
        reset(() => copied.set(false), 1500);
        toast(t("web.base.rich.copied"));
      },
      () => undefined,
    );
  };
  return (
    <View
      role="button"
      testID="issue-copy-id"
      accessibilityLabel={copied() ? t("web.base.rich.copied") : t("web.base.rich.copy")}
      tooltip={<Bubble text={copied() ? t("web.base.rich.copied") : t("web.base.rich.copy")} />}
      onPress={copy}
      class="shrink-0 flex-row items-center gap-1 rounded-md border border-line bg-side px-1.5 py-0.5 hover:border-line-strong hover:bg-hover active:translate-y-px focus-visible:outline-2 focus-visible:outline-focus"
    >
      <Text class={`font-mono text-xs tabular-nums ${copied() ? "text-leaf" : "text-muted"}`}>{`#${props.number}`}</Text>
      <Icon name={copied() ? "check" : "copy"} size={12} tone={copied() ? "leaf" : "muted"} />
    </View>
  );
}

/** Parent issue link shown above the issue title when nested under a parent issue. */
export function IssueTrail(props: {
  parentId?: string | undefined;
  parent?: Pick<Issue, "number" | "title"> | undefined;
  onOpenParent?: ((id: string) => void) | undefined;
}) {
  return (
    <If when={props.parentId}>
      {(parentId) => (
        <View accessibilityLabel={t("web.issue.detail.trail")} testID="issue-trail" class="mb-2.5 min-w-0 flex-row flex-wrap items-center gap-1.5">
          <View
            role="button"
            testID="parent-issue"
            onPress={() => props.onOpenParent?.(parentId())}
            class="min-w-0 max-w-64 shrink flex-row items-center gap-1 overflow-hidden rounded-md border border-line bg-side px-1.5 py-0.5 hover:border-line-strong hover:bg-hover"
          >
            <Icon name="indent" size={12} tone="water" />
            <Text class="min-w-0 truncate text-xs text-water">
              {props.parent ? `#${props.parent.number} ${props.parent.title}` : t("web.issue.family.parent")}
            </Text>
          </View>
        </View>
      )}
    </If>
  );
}
