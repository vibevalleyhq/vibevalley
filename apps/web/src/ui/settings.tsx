import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createContext, Show, useContext, type Accessor } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { KeyStatus } from "@vibevalley/protocol";

import { matches } from "#/base/search.ts";

import { IconButton, OutLink } from "./IconButton";
import { KeyMark } from "./KeyField";
import { SecretInput } from "./layout";
import { Hint } from "./Tip";

const viewStyles = stylex.create({
  settingsPageDiv: {
    display: "flex",
    maxWidth: "var(--container-3xl)",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 5)",
    paddingBottom: "calc(var(--spacing) * 6)",
  },
  settingsPageDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    paddingTop: "var(--spacing)",
  },
  settingsPageH2: {
    fontSize: "var(--text-xl)",
    lineHeight: "var(--text-xl--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  settingsPageSpan: {
    flex: "1",
  },
  settingsGroupSection: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 2)",
  },
  settingsGroupDiv: {
    display: "flex",
    alignItems: "baseline",
    gap: "calc(var(--spacing) * 2)",
    paddingInline: "var(--spacing)",
  },
  settingsGroupH3: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  settingsGroupSpan: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--color-muted)",
  },
  settingRow: {
    display: "flex",
    columnGap: "calc(var(--spacing) * 6)",
    rowGap: "calc(var(--spacing) * 2)",
    paddingInline: "calc(var(--spacing) * 4)",
    paddingBlock: "calc(var(--spacing) * 3)",
  },
  settingRowInline: {
    flexWrap: "wrap",
    alignItems: "center",
  },
  settingRowWide: {
    flexDirection: "column",
  },
  settingRowFound: {
    backgroundColor: {
      default: "var(--color-wheat)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-wheat) 15%, transparent)",
    },
  },
  settingRowText: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
    gap: "calc(var(--spacing) * .5)",
  },
  settingRowDiv: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  settingRowSpan: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-medium)",
  },
  settingRowControls: {
    display: "flex",
    maxWidth: "100%",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
  },
  settingRowControlsWide: {
    width: "100%",
  },
  settingRowControlsInline: {
    flexShrink: "0",
  },
  keyRowDiv: {
    width: "calc(var(--spacing) * 64)",
    maxWidth: "100%",
  },
  keyRowRemoving: {
    pointerEvents: "none",
    opacity: ".4",
  },
});

/** What is being searched for in Settings, lower-cased; "" when nothing. */
export const SettingsSearch = createContext<Accessor<string>>(() => "");

/** A section's page: its name, what it is about on hover, and what goes beside the name (a link, where it is stored). */
export function SettingsPage(props: { title: string; hint?: string; action?: JSX.Element; children: JSX.Element }) {
  return (
    <div {...stylex.attrs(viewStyles.settingsPageDiv)}>
      <div {...stylex.attrs(viewStyles.settingsPageDiv2)}>
        <h2 {...stylex.attrs(viewStyles.settingsPageH2)}>{props.title}</h2>
        <Show when={props.hint}>{(h) => <Hint text={h()} />}</Show>
        <span {...stylex.attrs(viewStyles.settingsPageSpan)} />
        {props.action}
      </div>
      {props.children}
    </div>
  );
}

/** Rows that belong together, in one card; title is a small heading over it, note what applies to all of them. */
export function SettingsGroup(props: { title?: string; note?: JSX.Element; children: JSX.Element }) {
  return (
    <section {...stylex.attrs(viewStyles.settingsGroupSection)}>
      <Show when={props.title !== undefined || props.note !== undefined}>
        <div {...stylex.attrs(viewStyles.settingsGroupDiv)}>
          <Show when={props.title}>{(title) => <h3 {...stylex.attrs(viewStyles.settingsGroupH3)}>{title()}</h3>}</Show>
          <span {...stylex.attrs(viewStyles.settingsPageSpan)} />
          <span {...stylex.attrs(viewStyles.settingsGroupSpan)}>{props.note}</span>
        </div>
      </Show>
      <div class="flex flex-col divide-y divide-line rounded-lg border border-line bg-side/60">{props.children}</div>
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
      {...stylex.attrs(
        viewStyles.settingRow,
        props.wide === true ? viewStyles.settingRowWide : viewStyles.settingRowInline,
        found() && viewStyles.settingRowFound,
      )}
      data-found={found() ? "" : undefined}
      data-testid={props.testid}
    >
      <div {...stylex.attrs(viewStyles.settingRowText)}>
        <div {...stylex.attrs(viewStyles.settingRowDiv)}>
          <span {...stylex.attrs(viewStyles.settingRowSpan)}>{props.label}</span>
          <Show when={props.tip}>{(tip) => <Hint text={tip()} />}</Show>
        </div>
        <Show when={props.hint}>{(hint) => <span {...stylex.attrs(viewStyles.settingsGroupSpan)}>{hint()}</span>}</Show>
      </div>
      <Show when={props.children}>
        <div {...stylex.attrs(viewStyles.settingRowControls, props.wide === true ? viewStyles.settingRowControlsWide : viewStyles.settingRowControlsInline)}>
          {props.children}
        </div>
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
      <div {...stylex.attrs(viewStyles.keyRowDiv, props.removing && viewStyles.keyRowRemoving)}>
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
