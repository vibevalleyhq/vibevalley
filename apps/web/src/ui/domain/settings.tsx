import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createContext, Show, useContext, type Accessor } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { KeyStatus } from "@vibevalley/protocol";

import { matches } from "#/base/search.ts";
import { IconButton, OutLink } from "#/ui/IconButton.tsx";
import { KeyMark } from "#/ui/KeyField.tsx";
import { SecretInput } from "#/ui/layout.tsx";
import { Hint } from "#/ui/Tip.tsx";

const styles = stylex.create({
  rows: {
    display: "flex",
    flexDirection: "column",
    borderRadius: "var(--radius-lg)",
    borderStyle: "solid",
    borderWidth: 1,
    borderColor: "var(--color-line)",
    backgroundColor: {
      default: "var(--color-side)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-side) 60%, transparent)",
    },
  },
  page: {
    display: "flex",
    maxWidth: "var(--container-3xl)",
    flexDirection: "column",
    gap: "1.25rem",
    paddingBottom: "1.5rem",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    paddingTop: "0.25rem",
  },
  title: {
    fontSize: "var(--text-xl)",
    lineHeight: "var(--leading-xl)",
    fontWeight: "var(--font-weight-semibold)",
  },
  spacer: {
    flex: "1",
  },
  group: {
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  groupHeader: {
    display: "flex",
    alignItems: "baseline",
    gap: "0.5rem",
    paddingInline: "0.25rem",
  },
  groupTitle: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-semibold)",
  },
  note: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  row: {
    display: "flex",
    columnGap: "1.5rem",
    rowGap: "0.5rem",
    borderBottomStyle: {
      default: "solid",
      ":last-child": "none",
    },
    borderBottomWidth: {
      default: 1,
      ":last-child": 0,
    },
    borderColor: "var(--color-line)",
    paddingInline: "1rem",
    paddingBlock: "0.75rem",
  },
  rowInline: {
    flexWrap: "wrap",
    alignItems: "center",
  },
  rowWide: {
    flexDirection: "column",
  },
  rowFound: {
    backgroundColor: {
      default: "var(--color-wheat)",
      "@supports (color:color-mix(in lab, red, red))": "color-mix(in oklab, var(--color-wheat) 15%, transparent)",
    },
  },
  rowBody: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
    gap: "0.125rem",
  },
  rowLabelLine: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
  },
  rowLabel: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-medium)",
  },
  controls: {
    display: "flex",
    maxWidth: "100%",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "0.5rem",
  },
  controlsWide: {
    width: "100%",
  },
  controlsInline: {
    flexShrink: "0",
  },
  keyBox: {
    width: "16rem",
    maxWidth: "100%",
  },
  removing: {
    pointerEvents: "none",
    opacity: ".4",
  },
});

/** What is being searched for in Settings, lower-cased; "" when nothing. */
export const SettingsSearch = createContext<Accessor<string>>(() => "");

/** A section's page: its name, what it is about on hover, and what goes beside the name (a link, where it is stored). */
export function SettingsPage(props: { title: string; hint?: string; action?: JSX.Element; children: JSX.Element }) {
  return (
    <div {...stylex.attrs(styles.page)}>
      <div {...stylex.attrs(styles.header)}>
        <h2 {...stylex.attrs(styles.title)}>{props.title}</h2>
        <Show when={props.hint}>{(h) => <Hint text={h()} />}</Show>
        <span {...stylex.attrs(styles.spacer)} />
        {props.action}
      </div>
      {props.children}
    </div>
  );
}

/** Rows that belong together, in one card; title is a small heading over it, note what applies to all of them. */
export function SettingsGroup(props: { title?: string; note?: JSX.Element; children: JSX.Element }) {
  return (
    <section {...stylex.attrs(styles.group)}>
      <Show when={props.title !== undefined || props.note !== undefined}>
        <div {...stylex.attrs(styles.groupHeader)}>
          <Show when={props.title}>{(title) => <h3 {...stylex.attrs(styles.groupTitle)}>{title()}</h3>}</Show>
          <span {...stylex.attrs(styles.spacer)} />
          <span {...stylex.attrs(styles.note)}>{props.note}</span>
        </div>
      </Show>
      <div {...stylex.attrs(styles.rows)}>{props.children}</div>
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
      {...stylex.attrs(styles.row, props.wide === true ? styles.rowWide : styles.rowInline, found() && styles.rowFound)}
      data-found={found() ? "" : undefined}
      data-testid={props.testid}
    >
      <div {...stylex.attrs(styles.rowBody)}>
        <div {...stylex.attrs(styles.rowLabelLine)}>
          <span {...stylex.attrs(styles.rowLabel)}>{props.label}</span>
          <Show when={props.tip}>{(tip) => <Hint text={tip()} />}</Show>
        </div>
        <Show when={props.hint}>{(hint) => <span {...stylex.attrs(styles.note)}>{hint()}</span>}</Show>
      </div>
      <Show when={props.children}>
        <div {...stylex.attrs(styles.controls, props.wide === true ? styles.controlsWide : styles.controlsInline)}>{props.children}</div>
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
      <div {...stylex.attrs(styles.keyBox, props.removing && styles.removing)}>
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
