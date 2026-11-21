import { Text, View, type JSX } from "nsh";

import { t } from "@vibevalley/i18n";
import type { KeyStatus } from "@vibevalley/protocol";

import { matches } from "../../infra/base/search";
import { type Accessor, createContext, useContext } from "../../infra/solid";
import { IconButton, OutLink } from "../IconButton";
import { KeyMark } from "../KeyField";
import { SecretInput } from "../layout";
import { Hint } from "../Tip";
import { mix } from "../tone";

/** What is being searched for in Settings, lower-cased; "" when nothing. */
export const SettingsSearch = createContext<Accessor<string>>(() => "");

/** A section's page: its name, what it is about on hover, and what goes beside the name (a link, where it is stored). */
export function SettingsPage(props: { title: string; hint?: string; action?: JSX.Element; children: JSX.Element }) {
  return (
    <View class="w-full max-w-3xl gap-5 pb-6">
      <View class="flex-row items-center gap-2 pt-1">
        <Text role="header" class="text-xl font-semibold text-ink">
          {props.title}
        </Text>
        <If when={props.hint}>{(h) => <Hint text={h()} />}</If>
        <View class="flex-1" />
        {props.action}
      </View>
      {props.children}
    </View>
  );
}

/** Rows that belong together, in one card; title is a small heading over it, note what applies to all of them. */
export function SettingsGroup(props: { title?: string; note?: string; children: JSX.Element }) {
  return (
    <View class="gap-2">
      <If when={props.title !== undefined || props.note !== undefined}>
        <View class="flex-row items-baseline gap-2 px-1">
          <If when={props.title}>
            {(title) => (
              <Text role="header" class="text-sm font-semibold text-ink">
                {title()}
              </Text>
            )}
          </If>
          <View class="flex-1" />
          <Text class="text-xs text-muted">{props.note ?? ""}</Text>
        </View>
      </If>
      <View class="rounded-lg border border-line" style={{ backgroundColor: mix("side", 0.6) }}>
        {props.children}
      </View>
    </View>
  );
}

/** One setting: its name and one line on what it does (hint), more on hover (tip), its control on the right. */
export function SettingRow(props: {
  label: string;
  hint?: string | undefined;
  tip?: string | undefined;
  wide?: boolean;
  testid?: string | undefined;
  /** The last row of its group draws no line under it (Tailwind's last:border-b-0 there). */
  last?: boolean;
  children?: JSX.Element;
}) {
  const query = useContext(SettingsSearch);
  const found = () => query() !== "" && matches(query(), [props.label, props.hint, props.tip]);
  return (
    <View
      testID={props.testid}
      class={`gap-x-6 gap-y-2 px-4 py-3 ${props.last === true ? "" : "border-b border-line"} ${props.wide === true ? "" : "flex-row flex-wrap items-center"}`}
      style={found() ? { backgroundColor: mix("wheat", 0.15) } : undefined}
    >
      <View class="min-w-50 flex-1 gap-0.5">
        <View class="flex-row items-center gap-1.5">
          <Text class="text-sm font-medium text-ink">{props.label}</Text>
          <If when={props.tip}>{(tip) => <Hint text={tip()} />}</If>
        </View>
        <If when={props.hint}>{(hint) => <Text class="text-xs text-muted">{hint()}</Text>}</If>
      </View>
      <If when={props.children}>
        <View class={`max-w-full flex-row flex-wrap items-center gap-2 ${props.wide === true ? "w-full" : "shrink-0"}`}>{props.children}</View>
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
