// 设置's parts: a page is groups of rows, a row a setting's name and a line on what it does on the left, its control on
// the right. One shape for every section, so a section reads like the others and the search finds its rows.

import { t } from "@vibevalley/i18n";
import type { KeyStatus } from "@vibevalley/protocol";
import type { JSX } from "@solidjs/web";
import { createContext, Show, useContext, type Accessor } from "solid-js";
import { matches } from "../base/search";
import { IconButton, IconLink } from "./IconButton";
import { KeyMark } from "./KeyField";
import { SecretInput } from "./layout";
import { Hint } from "./Tip";

/** What is being searched for in 设置, lower-cased; "" when nothing. */
export const SettingsSearch = createContext<Accessor<string>>(() => "");

/** A section's page: its name, what it is about on hover, and what goes beside the name (a link, where it is stored). */
export function SettingsPage(props: { title: string; hint?: string; action?: JSX.Element; children: JSX.Element }) {
  return (
    <div class="flex max-w-3xl flex-col gap-5 pb-6">
      <div class="flex items-center gap-2 pt-1">
        <h2 class="text-xl font-semibold">{props.title}</h2>
        <Show when={props.hint}>{(h) => <Hint text={h()} />}</Show>
        <span class="flex-1" />
        {props.action}
      </div>
      {props.children}
    </div>
  );
}

/** Rows that belong together, in one card; title is a small heading over it, note what applies to all of them. */
export function SettingsGroup(props: { title?: string; note?: JSX.Element; children: JSX.Element }) {
  return (
    <section class="flex flex-col gap-2">
      <Show when={props.title !== undefined || props.note !== undefined}>
        <div class="flex items-baseline gap-2 px-1">
          <Show when={props.title}>{(title) => <h3 class="text-sm font-semibold">{title()}</h3>}</Show>
          <span class="flex-1" />
          <span class="text-xs text-muted">{props.note}</span>
        </div>
      </Show>
      <div class="flex flex-col divide-y divide-line rounded-lg border border-line bg-side/60">{props.children}</div>
    </section>
  );
}

/**
 * One setting: its name and one line on what it does (hint), more on hover (tip), its control on the right. wide puts the
 * control under the words, for a field too wide to sit beside them.
 */
export function SettingRow(props: { label: string; hint?: string; tip?: string; wide?: boolean; testid?: string; children?: JSX.Element }) {
  const query = useContext(SettingsSearch);
  const found = () => query() !== "" && matches(query(), [props.label, props.hint, props.tip]);
  return (
    <div
      class={["flex gap-x-6 gap-y-2 px-4 py-3", props.wide ? "flex-col" : "flex-wrap items-center", { "bg-wheat/15": found() }]}
      data-found={found() ? "" : undefined}
      data-testid={props.testid}
    >
      <div class="flex min-w-0 flex-1 flex-col gap-0.5">
        <div class="flex items-center gap-1.5">
          <span class="text-sm font-medium">{props.label}</span>
          <Show when={props.tip}>{(tip) => <Hint text={tip()} />}</Show>
        </div>
        <Show when={props.hint}>{(hint) => <span class="text-xs text-muted">{hint()}</span>}</Show>
      </div>
      <Show when={props.children}>
        <div class={["flex items-center gap-2", props.wide ? "w-full" : "shrink-0"]}>{props.children}</div>
      </Show>
    </div>
  );
}

/**
 * A key as a row: whether one is in use (and its last four characters) as a mark, a field to type a new one, removing
 * it (marked until saved, as KeyField does), where to get one, and what goes after (a check).
 */
export function KeyRow(props: {
  label: string;
  hint?: string;
  tip?: string;
  status: KeyStatus;
  value: string;
  onInput: (value: string) => void;
  removing: boolean;
  onRemove: (removing: boolean) => void;
  link?: { readonly href: string; readonly label: string };
  placeholder?: string;
  after?: JSX.Element;
  testid?: string;
}) {
  return (
    <SettingRow label={props.label} hint={props.hint} tip={props.tip} testid={props.testid}>
      <KeyMark status={props.status} removing={props.removing} />
      <div class={["w-64", { "pointer-events-none opacity-40": props.removing }]}>
        <SecretInput
          data-testid="secret"
          aria-label={props.label}
          placeholder={props.placeholder ?? t("web.base.form.keepEmpty")}
          value={props.value}
          onInput={(e) => props.onInput(e.currentTarget.value)}
        />
      </div>
      <Show when={props.status.source === "settings"}>
        <IconButton
          testid="remove-key"
          icon={props.removing ? "undo" : "delete"}
          tone={props.removing ? undefined : "danger"}
          label={props.removing ? t("web.base.form.keepKey", { label: props.label }) : t("web.base.form.removeKey", { label: props.label })}
          onClick={() => props.onRemove(!props.removing)}
        />
      </Show>
      {props.after}
      <Show when={props.link}>{(l) => <IconLink href={l().href} label={l().label} />}</Show>
    </SettingRow>
  );
}
