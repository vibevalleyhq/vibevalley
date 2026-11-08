import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { t } from "@vibevalley/i18n";
import type { KeySource, KeyStatus } from "@vibevalley/protocol";

import { Icon } from "./Icon";
import { IconButton, OutLink } from "./IconButton";
import { Hint, Tip } from "./Tip";

const viewStyles = stylex.create({
  keyMark: {
    display: "inline-flex",
    flexShrink: "0",
    alignItems: "center",
    gap: "calc(var(--spacing) * .5)",
    borderRadius: ".25rem",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--text-2xs--line-height)",
    whiteSpace: "nowrap",
    outlineStyle: {
      default: "none",
      ":focus-visible": "none",
    },
    outlineWidth: {
      default: null,
      ":focus-visible": "2px",
    },
    outlineColor: {
      default: null,
      ":focus-visible": "var(--wb-focus)",
    },
  },
  keyMarkSpan: {
    color: "var(--wb-faint)",
  },
  keyMarkSpan2: {
    fontFamily: "var(--font-mono)",
    color: "var(--wb-muted)",
  },
  keyFieldDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "calc(var(--spacing) * 1.5)",
  },
  keyFieldDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
  },
  keyFieldSpan: {
    flex: "1",
  },
  keyFieldDiv3: {
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing)",
  },
  saveBar: {
    position: "sticky",
    bottom: "0",
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--wb-line)",
    backgroundColor: "var(--wb-page)",
    paddingBlock: "calc(var(--spacing) * 2.5)",
  },
  saveBarDiv: {
    minWidth: "0",
    flex: "1",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  undo: {
    display: "inline-flex",
    height: "calc(var(--spacing) * 7)",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 2.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: {
      default: "var(--wb-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-ink)",
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
  },
  save: {
    display: "inline-flex",
    height: "calc(var(--spacing) * 7)",
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    alignItems: "center",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--wb-accent)",
    backgroundColor: {
      default: "var(--wb-accent)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-accent-hover)",
      },
    },
    paddingInline: "calc(var(--spacing) * 2.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    color: "var(--wb-page)",
    opacity: {
      default: null,
      ":disabled": ".5",
    },
  },
});

const fromText = (s: KeySource) => t(`web.base.form.from.${s}`);

/** In use (and from where), not set, or to be removed on save. */
export function KeyMark(props: { status: KeyStatus; removing?: boolean }) {
  const text = () =>
    props.removing === true
      ? t("web.base.form.removeOnSave")
      : props.status.source
        ? props.status.hint
          ? t("web.base.form.inUse", { hint: props.status.hint, from: fromText(props.status.source) })
          : t("web.base.form.fromOnly", { from: fromText(props.status.source) })
        : t("web.base.form.unset");
  return (
    <Tip text={text()}>
      <span
        role="img"
        data-testid="key-mark"
        data-state={props.removing === true ? "removing" : (props.status.source ?? "unset")}
        data-hint={props.status.hint}
        aria-label={text()}
        tabindex={0}
        {...stylex.attrs(viewStyles.keyMark)}
      >
        {/* Said, not only drawn: a hollow dot did not read as "none saved". The key itself shows as its last four. */}
        <Show
          when={props.removing === true || props.status.source !== undefined}
          fallback={
            <span {...stylex.attrs(viewStyles.keyMarkSpan)} aria-hidden="true">
              {t("web.base.form.unset")}
            </span>
          }
        >
          <Icon name={props.removing === true ? "cross" : "check"} size={12} class={props.removing === true ? "text-berry" : "text-leaf"} />
          <Show when={props.removing !== true && props.status.hint}>
            <span {...stylex.attrs(viewStyles.keyMarkSpan2)} aria-hidden="true">
              {props.status.hint}
            </span>
          </Show>
        </Show>
      </span>
    </Tip>
  );
}

export function KeyField(props: {
  label: string;
  status: KeyStatus;
  removing: boolean;
  /** Marks the key for removal, or takes the mark back. */
  onRemove: (removing: boolean) => void;
  /** Where the key is made. */
  link?: { readonly href: string; readonly label: string } | undefined;
  tip?: string;
  /** A label as small as the fields' around it in a dense form. */
  small?: boolean;
  children: JSX.Element;
}) {
  return (
    <div {...stylex.attrs(viewStyles.keyFieldDiv)}>
      <div {...stylex.attrs(viewStyles.keyFieldDiv2)}>
        <span class={props.small === true ? "text-xs font-medium text-muted" : "text-sm font-semibold"}>{props.label}</span>
        <KeyMark status={props.status} removing={props.removing} />
        <Show when={props.tip}>{(t) => <Hint text={t()} />}</Show>
        <span {...stylex.attrs(viewStyles.keyFieldSpan)} />
        <Show when={props.link}>{(l) => <OutLink href={l().href} label={l().label} />}</Show>
      </div>
      <div {...stylex.attrs(viewStyles.keyFieldDiv3)}>
        <div class={["min-w-0 flex-1", { "pointer-events-none opacity-40": props.removing }]}>{props.children}</div>
        <Show when={props.status.source === "settings"}>
          <IconButton
            icon={props.removing ? "undo" : "delete"}
            tone={props.removing ? undefined : "danger"}
            label={props.removing ? t("web.base.form.keepKey", { label: props.label }) : t("web.base.form.removeKey", { label: props.label })}
            onClick={() => props.onRemove(!props.removing)}
          />
        </Show>
      </div>
    </div>
  );
}

/** Save and undo, shown while there is something to save; `left` says what went wrong. */
export function SaveBar(props: { dirty: boolean; busy: boolean; onSave: () => void; onUndo: () => void; left?: JSX.Element; extra?: JSX.Element }) {
  return (
    <div data-testid="save-bar" data-dirty={props.dirty ? "" : undefined} {...stylex.attrs(viewStyles.saveBar)}>
      <div {...stylex.attrs(viewStyles.saveBarDiv)}>{props.left}</div>
      {props.extra}
      <Show when={props.dirty}>
        <button type="button" data-testid="undo" onClick={() => props.onUndo()} {...stylex.attrs(viewStyles.undo)}>
          <Icon name="undo" size={14} />
          {t("web.base.form.undo")}
        </button>
      </Show>
      <button
        type="submit"
        data-testid="save"
        disabled={!props.dirty || props.busy}
        onClick={(e) => {
          e.preventDefault();
          props.onSave();
        }}
        {...stylex.attrs(viewStyles.save)}
      >
        {t("web.base.form.save")}
      </button>
    </div>
  );
}
