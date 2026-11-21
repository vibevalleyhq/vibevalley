// Ported from VibeValley apps/web/src/ui/layout.tsx: Split, ListCard,
// ListRow, Card, Quiet, Empty, Toggle (nsh/base's Switch, as base-ui's)
// and SecretInput. Not here: TextLink, titleBar and WindowStrip (the
// desktop window's own strip is the GPUI app's).
import { signal, Scroll, Text, untracked, View, type JSX } from "nsh";
import { Switch } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Link as A } from "../infra/router";
import { TextInput, type TextInputProps } from "./Field";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { CountPill } from "./Tag";
import { Bubble, Hint } from "./Tip";
import { mix } from "./tone";

type PageWidth = "prose" | "manage" | "wide";

const pageWidths: Record<PageWidth, string> = {
  prose: "w-full max-w-3xl",
  manage: "w-full max-w-5xl",
  wide: "w-full",
};

/** Standard page content container with consistent reading/management width and vertical rhythm. */
export function PageBody(props: { width?: PageWidth | undefined; class?: string | undefined; testid?: string | undefined; children: JSX.Element }) {
  const width = () => props.width ?? "manage";
  return (
    <View testID={props.testid} class={`gap-5 ${pageWidths[width()]} ${props.class ?? ""}`}>
      {props.children}
    </View>
  );
}

type KbdSize = "sm" | "md";

const kbdClasses: Record<KbdSize, { box: string; text: string }> = {
  sm: {
    box: "shrink-0 items-center justify-center rounded-xs border border-line bg-hover px-1.5 py-px",
    text: "font-mono text-2xs font-medium text-muted tabular-nums",
  },
  md: {
    box: "min-w-6 items-center justify-center rounded-xs border border-line bg-side px-1.5 py-0.5 shadow-raise",
    text: "font-mono text-2xs font-medium text-ink tabular-nums",
  },
};

/** Keycap label for keyboard shortcuts and inline key hints. */
export function Kbd(props: { size?: KbdSize | undefined; children: JSX.Element }) {
  const size = () => kbdClasses[props.size ?? "sm"];
  return (
    <View class={size().box}>
      <Text class={size().text}>{props.children}</Text>
    </View>
  );
}

export type BannerTone = "bad" | "warn" | "ok" | "info";

const bannerToneStyle: Record<BannerTone, { bg: string; text: string; mixColor: string; icon: IconName }> = {
  bad: { bg: "bg-bad-soft", text: "text-berry", mixColor: "berry", icon: "cross" },
  warn: { bg: "bg-warn-soft", text: "text-warn-ink", mixColor: "wheat", icon: "warn" },
  ok: { bg: "bg-ok-soft", text: "text-ok-ink", mixColor: "leaf", icon: "check" },
  info: { bg: "bg-side", text: "text-muted", mixColor: "line", icon: "info" },
};

/** Inline status or error notice; edge draws an edge-to-edge top strip under a viewer bar. */
export function Banner(props: {
  tone?: BannerTone | undefined;
  size?: "sm" | "md" | undefined;
  icon?: IconName | undefined;
  edge?: boolean | undefined;
  role?: "alert" | undefined;
  testID?: string | undefined;
  class?: string | undefined;
  textClass?: string | undefined;
  children: JSX.Element;
}) {
  const tone = () => props.tone ?? "bad";
  const s = () => bannerToneStyle[tone()];
  const edge = () => props.edge === true;
  const small = () => edge() || props.size === "sm";
  const info = () => tone() === "info";
  const textSize = () => (edge() ? "text-xs font-medium" : props.size === "sm" ? "text-xs leading-relaxed" : "text-sm");
  return (
    <View
      class={`flex-row items-start gap-2 ${
        edge() ? "border-b border-line px-3 py-2" : `rounded-md border px-3 py-2 ${info() ? "border-line" : ""}`
      } ${s().bg} ${props.class ?? ""}`}
      style={edge() || info() ? undefined : { borderColor: mix(s().mixColor, 0.25) }}
    >
      <View class="mt-0.5 shrink-0">
        <Icon name={props.icon ?? s().icon} size={small() ? 12 : 14} tone={info() ? "muted" : undefined} />
      </View>
      <If when={typeof props.children === "string"} else={<View class="min-w-0 flex-1">{props.children}</View>}>
        <Text testID={props.testID} role={props.role} class={`min-w-0 flex-1 ${textSize()} ${s().text} ${props.textClass ?? ""}`}>
          {props.children as string}
        </Text>
      </If>
    </View>
  );
}

/** Collapsible sidebar section header with unified 10px chevron, optional right-side badge/count pill, and trailing action. */
export function SidebarSection(props: {
  title: string;
  count?: number | undefined;
  collapsedBadge?: JSX.Element | undefined;
  action?: JSX.Element | undefined;
  open?: boolean | undefined;
  closed?: boolean | undefined;
  onToggle?: (() => void) | undefined;
  testID?: string | undefined;
  toggleTestID?: string | undefined;
  class?: string | undefined;
  listClass?: string | undefined;
  children: JSX.Element;
}) {
  const internal = signal(untracked(() => props.closed !== true));
  const expanded = () => (props.open !== undefined ? props.open : internal());
  const toggle = () => {
    if (props.onToggle) props.onToggle();
    else internal.set(!internal());
  };
  return (
    <View testID={props.testID} accessibilityLabel={props.title} class={`gap-0.5 ${props.class ?? ""}`}>
      <View class="h-7 flex-row items-center gap-1">
        <View
          role="button"
          testID={props.toggleTestID}
          accessibilityState={{ expanded: expanded() }}
          onPress={toggle}
          class="group h-7 min-w-0 flex-1 flex-row items-center gap-1.5 rounded-md px-1.5 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover"
        >
          <View
            class="h-3.5 w-3.5 shrink-0 items-center justify-center transition-transform duration-120 ease-out"
            style={{ transform: [{ rotate: expanded() ? "90deg" : "0deg" }] }}
          >
            <Icon name="expand" size={10} tone="faint" />
          </View>
          <Text class="min-w-0 flex-1 truncate text-xs font-semibold text-muted group-hover:text-ink">{props.title}</Text>
          <If when={!expanded()}>{props.collapsedBadge}</If>
          <If when={props.count !== undefined}>
            <CountPill count={props.count ?? 0} hoverBright />
          </If>
        </View>
        {props.action}
      </View>
      <If when={expanded()}>
        <View class={props.listClass ?? "gap-0.5"}>{props.children}</View>
      </If>
    </View>
  );
}

/** edge: a page's own list as a side column against the rail (its ListCard bare), not a card in a page that already has one. */
export function Split(props: { list: JSX.Element; children: JSX.Element; edge?: boolean }) {
  const edge = () => props.edge === true;
  return (
    <View class={`h-full min-h-0 flex-1 md:flex-row ${edge() ? "" : "gap-3"}`}>
      <Scroll
        class={`max-h-60 shrink-0 md:max-h-none md:w-70 ${edge() ? "border-b border-line bg-side md:border-r md:border-b-0" : ""}`}
        contentClass={edge() ? "px-2 py-3" : ""}
      >
        {props.list}
      </Scroll>
      <Scroll class="min-h-0 min-w-0 flex-1" contentClass={edge() ? "p-3" : ""}>
        {props.children}
      </Scroll>
    </View>
  );
}

/** bare: in a side column (Split edge), no box of its own. */
export function ListCard(props: { title: string; label?: string; action?: JSX.Element; children: JSX.Element; testid?: string; bare?: boolean }) {
  const bare = () => props.bare === true;
  return (
    <View accessibilityLabel={props.label ?? props.title} testID={props.testid} class={bare() ? "" : "rounded-lg border border-line bg-page"}>
      <View class={`shrink-0 flex-row items-center gap-2 ${bare() ? "h-8 px-2" : "h-10 border-b border-line px-3"}`}>
        <Text role="header" class={`min-w-0 flex-1 truncate ${bare() ? "text-xs font-medium text-faint" : "text-sm font-semibold text-ink"}`}>
          {props.title}
        </Text>
        {props.action}
      </View>
      <View class={bare() ? "gap-0.5" : "gap-0.5 p-1.5"}>{props.children}</View>
    </View>
  );
}

/** A 2 px left accent bar for the selected row of a sidebar list (zero layout shift). */
export function ActiveBar(props: { tall?: boolean; class?: string | undefined }) {
  return (
    <View class={`pointer-events-none absolute top-0 bottom-0 left-0.5 justify-center ${props.class ?? ""}`}>
      <View class={`${props.tall === true ? "h-4" : "h-3.5"} w-0.5 rounded-full bg-accent`} />
    </View>
  );
}

/** A row: a link to its detail, marked when it is the open one. */
export function ListRow(props: { to: string; item?: string; active?: boolean; title: string; line?: string; leading?: JSX.Element; trailing?: JSX.Element }) {
  const active = () => props.active === true;
  return (
    <A
      href={props.to}
      testID={props.item === undefined ? "list-row" : `list-row-${props.item}`}
      accessibilityLabel={props.title}
      accessibilityState={{ selected: active() }}
      class={`relative flex-row items-center gap-2.5 rounded-md border px-2.5 py-2 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus ${
        active() ? "border-line bg-selected" : "border-transparent hover:bg-hover"
      }`}
    >
      <If when={active()}>
        <ActiveBar tall />
      </If>
      {props.leading}
      <View class="min-w-0 flex-1 gap-0.5">
        <Text class="truncate text-sm font-medium text-ink">{props.title}</Text>
        <If when={props.line}>
          <Text class="truncate text-xs text-muted">{props.line}</Text>
        </If>
      </View>
      {props.trailing}
    </A>
  );
}

/** The open thing's card: a title, what sits beside it, and its body. A string title is a heading; another element is drawn as given. */
export function Card(props: { title?: JSX.Element; action?: JSX.Element; children: JSX.Element; class?: string | undefined; testid?: string; item?: string }) {
  return (
    <View testID={props.testid} class={`rounded-lg border border-line bg-page ${props.class ?? ""}`}>
      <If when={props.title !== undefined}>
        <View class="min-h-12 flex-row items-center gap-2 border-b border-line px-4 py-2.5">
          <View class="min-w-0 flex-1">
            <If when={typeof props.title === "string"} else={props.title}>
              <Text role="header" class="truncate text-base font-semibold text-ink">
                {props.title as string}
              </Text>
            </If>
          </View>
          {props.action}
        </View>
      </If>
      <View class="gap-4 p-4">{props.children}</View>
    </View>
  );
}

/** Nothing to show yet, in words. */
export function Quiet(props: { children: JSX.Element }) {
  return <Text class="text-sm leading-relaxed text-muted">{props.children}</Text>;
}

/** A place with nothing in it yet (docs/design/02-atomic-components.md): its icon, why it is empty, and the next step if there is one. */
export function Empty(props: { icon: IconName; children: JSX.Element; action?: JSX.Element; testid?: string; compact?: boolean | undefined }) {
  const compact = () => props.compact === true;
  return (
    <View
      testID={props.testid ?? "empty"}
      class={compact() ? "items-center justify-center rounded-lg border border-line bg-side px-6 py-8" : "min-h-48 flex-1 items-center justify-center p-6"}
    >
      <View class="max-w-sm items-center gap-3.5">
        <Icon name={props.icon} size={compact() ? 24 : 48} tone="faint" />
        <Text class="text-center text-sm leading-relaxed text-muted">{props.children}</Text>
        <If when={props.action}>
          <View class="pt-0.5">{props.action}</View>
        </If>
      </View>
    </View>
  );
}

function ToggleSwitch(props: {
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean | undefined;
  ariaLabel: string;
  testid?: string | undefined;
  class?: string | undefined;
}) {
  return (
    <Switch
      testID={props.testid}
      checked={props.checked}
      disabled={props.disabled}
      hitSlop={4}
      accessibilityLabel={props.ariaLabel}
      onChange={(e) => props.onChange(e.checked)}
      class={props.class}
      trackClass="h-4 w-7 justify-center rounded-full border border-line bg-selected p-0.5 transition-colors duration-180 ease-out checked:border-accent checked:bg-accent focus-visible:outline-2 focus-visible:outline-focus"
      thumbClass="size-2.5 rounded-full bg-paper shadow-raise transition-transform duration-180 ease-out checked:translate-x-3"
    />
  );
}

/** An on/off with its label, and what it means under it (hint) or behind an info icon (tip); `bare` renders only the switch. */
export function Toggle(props: {
  label?: string | undefined;
  /** What a screen reader says, where the label alone does not say which. */
  ariaLabel?: string | undefined;
  hint?: string | undefined;
  tip?: string | undefined;
  bare?: boolean | undefined;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean | undefined;
  testid?: string | undefined;
}) {
  const bare = () => props.bare === true || !props.label;
  const accessibilityLabel = () => props.ariaLabel ?? props.label ?? "";
  return (
    <If
      when={!bare()}
      else={
        <ToggleSwitch
          testid={props.testid}
          checked={props.checked}
          disabled={props.disabled}
          ariaLabel={accessibilityLabel()}
          onChange={props.onChange}
          class={`shrink-0 ${props.disabled === true ? "opacity-50" : ""}`}
        />
      }
    >
      <View class={`flex-row items-start gap-2.5 ${props.disabled === true ? "opacity-50" : ""}`}>
        <ToggleSwitch
          testid={props.testid}
          checked={props.checked}
          disabled={props.disabled}
          ariaLabel={accessibilityLabel()}
          onChange={props.onChange}
          class="mt-0.5 shrink-0"
        />
        <View class="min-w-0 flex-1 gap-0.5">
          <View class="flex-row items-center gap-1.5">
            <Text class="text-sm text-ink">{props.label ?? ""}</Text>
            <If when={props.tip}>{(tip) => <Hint text={tip()} />}</If>
          </View>
          <If when={props.hint}>
            <Text class="text-xs leading-relaxed text-muted">{props.hint}</Text>
          </If>
        </View>
      </View>
    </If>
  );
}

/** A key: hidden until the eye is pressed. */
export function SecretInput(props: TextInputProps) {
  const shown = signal(false);
  const label = () => (shown() ? t("web.base.secret.hide") : t("web.base.secret.peek"));
  return (
    <View class="flex-row items-center">
      <TextInput {...props} masked={!shown()} class={`pr-8 font-mono ${props.class ?? ""}`} />
      <View
        role="button"
        testID="reveal"
        accessibilityState={{ selected: shown() }}
        accessibilityLabel={label()}
        tooltip={<Bubble text={label()} />}
        onPress={() => shown.set(!shown())}
        class="absolute top-1 right-1 size-6 items-center justify-center rounded-sm transition duration-120 ease-out hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
      >
        <Icon name={shown() ? "hide" : "show"} size={14} tone="muted" />
      </View>
    </View>
  );
}
