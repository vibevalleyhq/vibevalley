import type { JSX } from "@solidjs/web";
import { createContext, For, Show, useContext, type Accessor } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { Feature, KeyStatus } from "@vibevalley/protocol";

import { matches } from "#/base/search.ts";
import { ready, settingsQuery, useQuery } from "#/infra/query.ts";
import { fixOf } from "#/infra/readiness.ts";
import { Icon } from "#/ui/Icon.tsx";
import { IconButton, OutLink } from "#/ui/IconButton.tsx";
import { KeyMark } from "#/ui/KeyField.tsx";
import { SecretInput, TextLink } from "#/ui/layout.tsx";
import { Hint } from "#/ui/Tip.tsx";

/** What is being searched for in Settings, lower-cased; "" when nothing. */
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
      <div class="flex flex-col rounded-lg border border-line bg-side/60">{props.children}</div>
    </section>
  );
}

/** One setting: its name and one line on what it does (hint), more on hover (tip), its control on the right. */
export function SettingRow(props: {
  label: string;
  hint?: string | undefined;
  tip?: string | undefined;
  wide?: boolean;
  testid?: string | undefined;
  children?: JSX.Element;
}) {
  const query = useContext(SettingsSearch);
  const found = () => query() !== "" && matches(query(), [props.label, props.hint, props.tip]);
  return (
    <div
      class={[
        "flex gap-x-6 gap-y-2 border-b border-line px-4 py-3 last:border-b-0",
        props.wide === true ? "flex-col" : "flex-wrap items-center",
        found() && "bg-wheat/15",
      ]}
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
        <div class={["flex max-w-full flex-wrap items-center gap-2", props.wide === true ? "w-full" : "shrink-0"]}>{props.children}</div>
      </Show>
    </div>
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
  control?: Pick<JSX.InputHTMLAttributes<HTMLInputElement>, "id" | "aria-invalid" | "aria-describedby" | "onBlur">;
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
      <div class={["w-64 max-w-full", props.removing && "pointer-events-none opacity-40"]}>
        <SecretInput
          {...props.control}
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
      <Show when={props.link}>{(l) => <OutLink href={l().href} label={l().label} />}</Show>
    </SettingRow>
  );
}

/** Whether the features a page sets up can be used now, as the server says (SettingsStatus.readiness), and where to
 * fix the ones that cannot. Says nothing while the settings are on their way. */
export function Readiness(props: { features: readonly Feature[] }) {
  const settings = useQuery(settingsQuery);
  const readiness = () => ready(settings, undefined)?.readiness;
  return (
    <Show when={readiness()}>
      {(all) => (
        <div class="flex flex-col gap-1" data-testid="readiness">
          <For each={props.features}>
            {(feature) => {
              const state = () => all()[feature];
              const name = t(`web.setting.feature.${feature}`);
              const lacking = () => {
                const now = state();
                return now.ready ? undefined : now.missing;
              };
              return (
                <div class="flex flex-wrap items-center gap-2 text-sm" data-key={feature} data-state={state().ready ? "ready" : "lacking"}>
                  <Show
                    when={lacking()}
                    fallback={
                      <>
                        <span class="text-leaf">
                          <Icon name="ticked" size={14} />
                        </span>
                        {t("web.setting.readiness.ready", { feature: name })}
                      </>
                    }
                  >
                    {(missing) => (
                      <>
                        <span class="text-berry">
                          <Icon name="warn" size={14} />
                        </span>
                        {t("web.setting.readiness.lacks", { feature: name, why: fixOf(missing()).words })}
                        <TextLink href={fixOf(missing()).href}>{t("web.setting.readiness.fix")}</TextLink>
                      </>
                    )}
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      )}
    </Show>
  );
}
