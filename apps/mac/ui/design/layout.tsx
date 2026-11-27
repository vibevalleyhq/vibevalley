import { computed, effect, signal, Scroll, Text, untracked, View, type JSX } from "nsh";
import { Switch } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { TextInput, type TextInputProps } from "./Field";
import { followDesignHref, useDesignHost } from "./host";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { motionClass, motionEnter } from "./motion";
import { CountPill } from "./Tag";
import { Bubble, Hint } from "./Tip";
import { mix } from "./tone";

type PageWidth = "prose" | "manage" | "wide";

const pageWidths: Record<PageWidth, string> = {
  prose: "w-full max-w-3xl",
  manage: "w-full max-w-5xl",
  wide: "w-full",
};

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

/** `edge` makes it an edge-to-edge top strip under a viewer bar. */
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
          {props.children}
        </Text>
      </If>
    </View>
  );
}

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
  const expanded = () => props.open ?? internal();
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
          class="group h-7 min-w-0 flex-1 flex-row items-center gap-1.5 rounded-md px-1.5 focus-visible:outline-2 focus-visible:outline-focus hover:bg-hover"
        >
          <View class="h-4 w-4 shrink-0 items-center justify-center">
            <Icon name={expanded() ? "choose" : "expand"} size={14} tone="muted" />
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

/** 2px accent bar, absolutely placed so selecting a row shifts no layout. */
export function ActiveBar(props: { tall?: boolean; class?: string | undefined }) {
  return (
    <View class={`pointer-events-none absolute top-0 bottom-0 left-0.5 justify-center ${props.class ?? ""}`}>
      <View class={`${props.tall === true ? "h-4" : "h-3.5"} w-0.5 rounded-full bg-accent`} />
    </View>
  );
}

/** A row: a link to its detail, marked when it is the open one. */
export function ListRow(props: { to: string; item?: string; active?: boolean; title: string; line?: string; leading?: JSX.Element; trailing?: JSX.Element }) {
  const designHost = useDesignHost();
  const active = () => props.active === true;
  return (
    <View
      role="link"
      testID={props.item === undefined ? "list-row" : `list-row-${props.item}`}
      accessibilityLabel={props.title}
      accessibilityState={{ selected: active() }}
      onPress={() => followDesignHref(designHost, props.to)}
      class={`relative flex-row items-center gap-2.5 rounded-md border px-2.5 py-2 focus-visible:outline-2 focus-visible:outline-focus ${
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
    </View>
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
                {props.title}
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

type EmptyVariant = "firstRun" | "filtered" | "unselected" | "zero" | "error";

const emptyMedallion: Record<EmptyVariant, { box: string; iconTone: string; iconSize: 16 | 20 | 24 }> = {
  firstRun: { box: "size-12 rounded-xl border border-line bg-page shadow-raise", iconTone: "accent", iconSize: 24 },
  filtered: { box: "size-9 rounded-lg border border-line bg-page", iconTone: "muted", iconSize: 16 },
  unselected: { box: "size-9 rounded-lg bg-hover", iconTone: "faint", iconSize: 16 },
  zero: { box: "size-10 rounded-xl bg-ok-soft", iconTone: "leaf", iconSize: 20 },
  error: { box: "size-10 rounded-xl bg-page border border-line", iconTone: "berry", iconSize: 20 },
};

/**
 * Semantic empty state across 4+ tiers (`firstRun`, `filtered`, `unselected`, `zero`, `error`):
 * dual-layer microcopy (`title` + `description`/`children`), Papertrails medallion backdrop,
 * optional `<Kbd>` shortcut cap, primary/secondary actions, and 200ms anti-flash gate when `pending`/`delayMs` is set.
 */
export function Empty(props: {
  icon: IconName;
  variant?: EmptyVariant | undefined;
  title?: string | undefined;
  description?: JSX.Element | undefined;
  children?: JSX.Element | undefined;
  action?: JSX.Element | undefined;
  secondaryAction?: JSX.Element | undefined;
  shortcut?: string | undefined;
  illustration?: JSX.Element | undefined;
  /** Suppresses empty-state flash while an upstream query is still fetching; reveals after `delayMs` (default 200ms). */
  pending?: boolean | undefined;
  delayMs?: number | undefined;
  testid?: string | undefined;
  compact?: boolean | undefined;
}) {
  const effectiveDelay = computed(() => props.delayMs ?? (props.pending !== undefined ? 200 : 0));
  const revealed = signal(untracked(() => props.pending !== true && effectiveDelay() <= 0));

  effect(() => {
    if (props.pending === true) {
      revealed.set(false);
      return;
    }
    const wait = effectiveDelay();
    if (wait <= 0) {
      revealed.set(true);
      return;
    }
    const timer = setTimeout(() => revealed.set(true), wait);
    return () => clearTimeout(timer);
  });

  const variant = () => props.variant;
  const compact = () => props.compact === true;
  const body = () => props.description ?? props.children;
  const containerClass = () => {
    const v = variant();
    const enter = motionEnter("normal");
    if (v === "error") {
      return `${compact() ? "px-5 py-5" : "px-6 py-7"} items-center justify-center rounded-xl border border-line bg-bad-soft ${enter}`;
    }
    if (v === "unselected") {
      return `${compact() ? "px-4 py-5" : "min-h-40 flex-1 p-6"} items-center justify-center ${enter}`;
    }
    if (v === "zero") {
      return `${compact() ? "px-4 py-5" : "px-6 py-7"} items-center justify-center rounded-xl border border-line bg-side ${enter}`;
    }
    if (v === "filtered") {
      return `${compact() ? "px-5 py-5" : "px-6 py-7"} items-center justify-center rounded-lg border border-line bg-side ${enter}`;
    }
    if (v === "firstRun") {
      return `${compact() ? "px-5 py-6" : "min-h-48 flex-1 px-6 py-8"} items-center justify-center rounded-xl border border-line bg-side ${enter}`;
    }
    return compact()
      ? `items-center justify-center rounded-lg border border-line bg-side px-6 py-8 ${enter}`
      : `min-h-48 flex-1 items-center justify-center p-6 ${enter}`;
  };
  const medallion = () => {
    const v = variant();
    if (v !== undefined) return emptyMedallion[v];
    return compact()
      ? { box: "size-9 rounded-lg border border-line bg-page", iconTone: "faint", iconSize: 16 as const }
      : { box: "size-12 rounded-xl border border-line bg-side shadow-raise", iconTone: "faint", iconSize: 24 as const };
  };
  const titleClass = () => {
    const v = variant();
    if (v === "error") return "text-center text-sm font-semibold text-berry";
    if (v === "firstRun") return "text-center text-base font-semibold text-ink";
    return "text-center text-sm font-medium text-ink";
  };
  const descClass = () =>
    compact() || variant() === "filtered" || variant() === "zero"
      ? "text-center text-xs leading-relaxed text-muted"
      : "text-center text-sm leading-relaxed text-muted";

  return (
    <If when={revealed()}>
      <View testID={props.testid ?? "empty"} class={containerClass()}>
        <View class={`max-w-sm items-center ${compact() ? "gap-2.5" : "gap-3"}`}>
          <If
            when={props.illustration !== undefined}
            else={
              <View class={`items-center justify-center ${medallion().box}`}>
                <Icon name={props.icon} size={medallion().iconSize} tone={medallion().iconTone} />
              </View>
            }
          >
            {props.illustration}
          </If>
          <View class="items-center gap-1">
            <If when={props.title}>{(heading) => <Text class={titleClass()}>{heading()}</Text>}</If>
            <If when={body()}>
              {(text) => (
                <If when={typeof text() === "string"} else={text()}>
                  <Text class={descClass()}>{text()}</Text>
                </If>
              )}
            </If>
          </View>
          <If when={props.shortcut}>{(keys) => <Kbd size="md">{keys()}</Kbd>}</If>
          <If when={props.action !== undefined || props.secondaryAction !== undefined}>
            <View class="flex-row flex-wrap items-center justify-center gap-2 pt-0.5">
              {props.action}
              {props.secondaryAction}
            </View>
          </If>
        </View>
      </View>
    </If>
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
      trackClass="h-4 w-7 justify-center rounded-full border border-line bg-selected p-0.5 checked:border-accent checked:bg-accent focus-visible:outline-2 focus-visible:outline-focus"
      thumbClass={`size-2.5 rounded-full bg-paper shadow-raise ${motionClass("transition-transform duration-180 ease-out")} checked:translate-x-3`}
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
        class="absolute top-1 right-1 size-6 items-center justify-center rounded-sm hover:bg-hover focus-visible:outline-2 focus-visible:outline-focus"
      >
        <Icon name={shown() ? "hide" : "show"} size={14} tone="muted" />
      </View>
    </View>
  );
}
