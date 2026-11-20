// Ported from VibeValley apps/web/src/ui/layout.tsx: Split, ListCard,
// ListRow, Card, Quiet, Empty, Toggle (nsh/base's Switch, as base-ui's)
// and SecretInput. Not here: TextLink, titleBar and WindowStrip (the
// desktop window's own strip is the GPUI app's).
import { signal, Scroll, Text, View, type JSX } from "nsh";
import { Switch } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Link as A } from "../infra/router";
import { TextInput, type TextInputProps } from "./Field";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { Bubble, Hint } from "./Tip";

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

/** A row: a link to its detail, marked when it is the open one. */
export function ListRow(props: { to: string; item?: string; active?: boolean; title: string; line?: string; leading?: JSX.Element; trailing?: JSX.Element }) {
  return (
    <A
      href={props.to}
      testID={props.item === undefined ? "list-row" : `list-row-${props.item}`}
      accessibilityLabel={props.title}
      accessibilityState={{ selected: props.active === true }}
      class={`flex-row items-center gap-2.5 rounded-md px-2.5 py-2 transition duration-120 ease-out focus-visible:outline-2 focus-visible:outline-focus ${props.active === true ? "bg-selected" : "hover:bg-hover"}`}
    >
      {props.leading}
      <View class="min-w-0 flex-1 gap-0.5">
        <Text class={`truncate text-sm text-ink ${props.active === true ? "font-semibold" : "font-medium"}`}>{props.title}</Text>
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

/** A place with nothing in it yet (docs/style/design.md): its icon, why it is empty, and the next step if there is one. */
export function Empty(props: { icon: IconName; children: JSX.Element; action?: JSX.Element; testid?: string }) {
  return (
    <View testID={props.testid ?? "empty"} class="min-h-48 flex-1 items-center justify-center p-6">
      <View class="max-w-sm items-center gap-3.5">
        <Icon name={props.icon} size={48} tone="faint" />
        <Text class="text-center text-sm leading-relaxed text-muted">{props.children}</Text>
        <If when={props.action}>
          <View class="pt-0.5">{props.action}</View>
        </If>
      </View>
    </View>
  );
}

/** An on/off with its label, and what it means under it (hint) or behind an info icon (tip). */
export function Toggle(props: {
  label: string;
  /** What a screen reader says, where the label alone does not say which. */
  ariaLabel?: string;
  hint?: string | undefined;
  tip?: string;
  checked: boolean;
  onChange: (on: boolean) => void;
  disabled?: boolean;
  testid?: string;
}) {
  return (
    <View class={`flex-row items-start gap-2.5 ${props.disabled === true ? "opacity-50" : ""}`}>
      <Switch
        testID={props.testid}
        checked={props.checked}
        disabled={props.disabled}
        hitSlop={4}
        accessibilityLabel={props.ariaLabel ?? props.label}
        onChange={(e) => props.onChange(e.checked)}
        class="mt-0.5 shrink-0"
        trackClass="h-4 w-7 justify-center rounded-full border border-line bg-selected p-0.5 transition-colors duration-180 ease-out checked:border-accent checked:bg-accent focus-visible:outline-2 focus-visible:outline-focus"
        thumbClass="size-2.5 rounded-full bg-page shadow-raise transition-transform duration-180 ease-out checked:translate-x-3"
      />
      <View class="min-w-0 flex-1 gap-0.5">
        <View class="flex-row items-center gap-1.5">
          <Text class="text-sm text-ink">{props.label}</Text>
          <If when={props.tip}>{(tip) => <Hint text={tip()} />}</If>
        </View>
        <If when={props.hint}>
          <Text class="text-xs leading-relaxed text-muted">{props.hint}</Text>
        </If>
      </View>
    </View>
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
