import { Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import type { KeyStatus } from "@vibevalley/protocol";

import { matches } from "../../infra/base/search";
import { type Accessor, createContext, useContext } from "../../infra/solid";
import { Icon } from "../Icon";
import { IconButton, OutLink } from "../IconButton";
import type { IconName } from "../icons";
import { KeyMark } from "../KeyField";
import { SecretInput } from "../layout";
import { Hint } from "../Tip";
import { mix } from "../tone";

/** What is being searched for in Settings, lower-cased; "" when nothing. */
export const SettingsSearch = createContext<Accessor<string>>(() => "");

/** A section's page: crisp title + 1-line description, optional right action, and grouped cards in a 720px reading column. */
export function SettingsPage(props: {
  title: string;
  description?: string | undefined;
  hint?: string | undefined;
  action?: JSX.Element;
  children: JSX.Element;
}) {
  const subtitle = () => props.description ?? props.hint;
  return (
    <View class="w-full max-w-180 gap-6 pb-10">
      <View class="flex-row items-start justify-between gap-4">
        <View class="min-w-0 flex-1 gap-1">
          <Text role="header" class="text-xl font-semibold text-ink">
            {props.title}
          </Text>
          <If when={subtitle()}>{(line) => <Text class="text-xs leading-relaxed text-muted">{line()}</Text>}</If>
        </View>
        <If when={props.action}>
          <View class="shrink-0 flex-row items-center gap-2 pt-0.5">{props.action}</View>
        </If>
      </View>
      {props.children}
    </View>
  );
}

/** Rows that belong together inside one elevated hairline-bordered card with a quiet section heading and optional scope chip. */
export function SettingsGroup(props: {
  title?: string | undefined;
  note?: string | undefined;
  action?: JSX.Element | undefined;
  testid?: string | undefined;
  children: JSX.Element;
}) {
  const hasHead = () => props.title !== undefined || props.note !== undefined || props.action !== undefined;
  return (
    <View testID={props.testid} class="gap-2">
      <If when={hasHead()}>
        <View class="flex-row items-center justify-between gap-3 px-0.5">
          <View class="min-w-0 flex-1 flex-row items-center gap-2">
            <If when={props.title}>
              {(title) => (
                <Text role="header" class="truncate text-xs font-semibold text-muted">
                  {title()}
                </Text>
              )}
            </If>
          </View>
          <View class="shrink-0 flex-row items-center gap-2">
            <If when={props.note}>
              {(note) => (
                <View class="rounded-full bg-hover px-2 py-0.5">
                  <Text class="text-2xs font-medium text-faint">{note()}</Text>
                </View>
              )}
            </If>
            {props.action}
          </View>
        </View>
      </If>
      <View class="overflow-hidden rounded-xl border border-line bg-elevated">{props.children}</View>
    </View>
  );
}

/** One setting row: optional leading icon, name + 1-line subtitle on the left, right-aligned control, and hairline divider. */
export function SettingRow(props: {
  label: string;
  hint?: string | undefined;
  tip?: string | undefined;
  icon?: IconName | undefined;
  wide?: boolean;
  testid?: string | undefined;
  /** The last row of its group draws no line under it. */
  last?: boolean;
  children?: JSX.Element;
}) {
  const query = useContext(SettingsSearch);
  const found = () => query() !== "" && matches(query(), [props.label, props.hint, props.tip]);
  return (
    <View
      testID={props.testid}
      class={`min-h-13 gap-x-4 gap-y-2.5 px-4 py-3 ${props.last === true ? "" : "border-b border-line"} ${
        props.wide === true ? "" : "flex-row flex-wrap items-center justify-between"
      }`}
      style={found() ? { backgroundColor: mix("wheat", 0.14) } : undefined}
    >
      <View class="min-w-48 flex-1 flex-row items-center gap-3">
        <If when={props.icon}>
          {(name) => (
            <View class="size-7 shrink-0 items-center justify-center rounded-md bg-hover">
              <Icon name={name()} size={14} tone="muted" />
            </View>
          )}
        </If>
        <View class="min-w-0 flex-1 gap-0.5">
          <View class="flex-row items-center gap-1.5">
            <Text class="text-sm font-medium text-ink">{props.label}</Text>
            <If when={props.tip}>{(tip) => <Hint text={tip()} />}</If>
          </View>
          <If when={props.hint}>{(hint) => <Text class="text-xs leading-snug text-muted">{hint()}</Text>}</If>
        </View>
      </View>
      <If when={props.children}>
        <View class={`max-w-full flex-row flex-wrap items-center gap-2 ${props.wide === true ? "w-full" : "shrink-0 justify-end"}`}>{props.children}</View>
      </If>
    </View>
  );
}

/** A key as a row: whether one is in use as a mark, a field to type a new one, removing it, where to get one, and what goes after (a check). */
export function KeyRow(props: {
  label: string;
  hint?: string;
  tip?: string;
  status: KeyStatus;
  value: string;
  onInput: (value: string) => void;
  control?: { onBlur?: () => void };
  removing: boolean;
  onRemove: (removing: boolean) => void;
  link?: { readonly href: string; readonly label: string };
  placeholder?: string;
  after?: JSX.Element;
  testid?: string;
  last?: boolean;
}) {
  return (
    <SettingRow label={props.label} hint={props.hint} tip={props.tip} testid={props.testid} last={props.last}>
      <KeyMark status={props.status} removing={props.removing} />
      <View class="w-64 max-w-full" style={{ opacity: props.removing ? 0.4 : 1, pointerEvents: props.removing ? "none" : "auto" }}>
        <SecretInput
          testID="secret"
          accessibilityLabel={props.label}
          placeholder={props.placeholder ?? t("web.base.form.keepEmpty")}
          value={props.value}
          onInput={(v) => props.onInput(v)}
        />
      </View>
      <If when={props.status.source === "settings"}>
        <IconButton
          testid="remove-key"
          icon={props.removing ? "undo" : "delete"}
          tone={props.removing ? undefined : "danger"}
          label={props.removing ? t("web.base.form.keepKey", { label: props.label }) : t("web.base.form.removeKey", { label: props.label })}
          onClick={() => props.onRemove(!props.removing)}
        />
      </If>
      {props.after}
      <If when={props.link}>{(l) => <OutLink href={l().href} label={l().label} />}</If>
    </SettingRow>
  );
}
