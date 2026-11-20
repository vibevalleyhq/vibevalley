import { signal, Scroll, Text, View, type JSX } from "nsh";
import { Switch } from "nsh/base";

import { t } from "@vibevalley/i18n";

import { Link as A } from "../infra/router";
import { TextInput, type TextInputProps } from "./Field";
import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { Hint } from "./Tip";

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
      <View class={bare() ? "gap-px" : "p-1"}>{props.children}</View>
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
      class={`flex-row items-center gap-2.5 rounded-md px-2.5 py-2 ${props.active === true ? "bg-selected" : "hover:bg-hover"}`}
    >
      {props.leading}
      <View class="min-w-0 flex-1">
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
        <View class="min-h-12 flex-row items-center gap-2 border-b border-line px-4 py-2">
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
  return <Text class="text-sm text-muted">{props.children}</Text>;
}

/** A place with nothing in it yet (docs/style/design.md): its icon, why it is empty, and the next step if there is one. */
export function Empty(props: { icon: IconName; children: JSX.Element; action?: JSX.Element; testid?: string }) {
  return (
    <View testID={props.testid ?? "empty"} class="min-h-48 flex-1 items-center justify-center p-6">
      <View class="max-w-sm items-center gap-3">
        <Icon name={props.icon} size={48} tone="faint" />
        <Text class="text-center text-sm text-muted">{props.children}</Text>
        {props.action}
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
    <View class={`flex-row items-start gap-2 ${props.disabled === true ? "opacity-50" : ""}`}>
      <Switch
        testID={props.testid}
        checked={props.checked}
        disabled={props.disabled}
        accessibilityLabel={props.ariaLabel ?? props.label}
        onChange={(e) => props.onChange(e.checked)}
        class="mt-0.5 shrink-0"
        trackClass="h-4 w-7 justify-center rounded-full bg-selected p-0.5 transition-colors duration-180 ease-out checked:bg-accent"
        thumbClass="size-3 rounded-full bg-page shadow-raise transition-transform duration-180 ease-out checked:translate-x-3"
      />
      <View class="min-w-0 flex-1">
        <View class="flex-row items-center gap-1">
          <Text class="text-sm text-ink">{props.label}</Text>
          <If when={props.tip}>{(tip) => <Hint text={tip()} />}</If>
        </View>
        <If when={props.hint}>
          <Text class="text-xs text-muted">{props.hint}</Text>
        </If>
      </View>
    </View>
  );
}

/** A key: hidden until the eye is pressed. */
export function SecretInput(props: TextInputProps) {
  const shown = signal(false);
  return (
    <View class="flex-row items-center">
      <TextInput {...props} masked={!shown()} class={`pr-9 font-mono ${props.class ?? ""}`} />
      <View
        role="button"
        testID="reveal"
        accessibilityState={{ selected: shown() }}
        accessibilityLabel={shown() ? t("web.base.secret.hide") : t("web.base.secret.peek")}
        onPress={() => shown.set(!shown())}
        class="absolute top-0.5 right-1 size-7 items-center justify-center rounded-sm hover:bg-hover"
      >
        <Icon name={shown() ? "hide" : "show"} size={16} tone="faint" />
      </View>
    </View>
  );
}
