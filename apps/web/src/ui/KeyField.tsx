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
    gap: "0.125rem",
    borderRadius: "var(--radius-sm)",
    fontSize: "var(--text-2xs)",
    lineHeight: "var(--leading-2xs)",
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
      ":focus-visible": "var(--color-focus)",
    },
  },
  keyMarkSpan: {
    color: "var(--color-faint)",
  },
  keyMarkSpan2: {
    fontFamily: "var(--font-mono)",
    color: "var(--color-muted)",
  },
  keyMarkRemoving: {
    color: "var(--color-berry)",
  },
  keyMarkPresent: {
    color: "var(--color-leaf)",
  },
  keyFieldDiv: {
    display: "flex",
    flexDirection: "column",
    gap: "0.375rem",
  },
  keyFieldDiv2: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
  },
  keyFieldLabelSmall: {
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-muted)",
  },
  keyFieldLabelNormal: {
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-semibold)",
  },
  keyFieldSpan: {
    flex: "1",
  },
  keyFieldDiv3: {
    display: "flex",
    alignItems: "center",
    gap: "0.25rem",
  },
  keyFieldControlWrap: {
    minWidth: "0",
    flex: "1",
  },
  keyFieldControlRemoving: {
    pointerEvents: "none",
    opacity: ".4",
  },
  saveBar: {
    position: "sticky",
    bottom: "0",
    display: "flex",
    alignItems: "center",
    gap: "0.5rem",
    borderTopStyle: "solid",
    borderTopWidth: "1px",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    paddingBlock: "0.625rem",
  },
  saveBarDiv: {
    minWidth: "0",
    flex: "1",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  undo: {
    display: "inline-flex",
    height: "1.75rem",
    cursor: "pointer",
    alignItems: "center",
    gap: "0.375rem",
    borderRadius: "var(--radius-md)",
    paddingInline: "0.625rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  save: {
    display: "inline-flex",
    height: "1.75rem",
    cursor: {
      default: "pointer",
      ":disabled": "default",
    },
    alignItems: "center",
    borderRadius: "var(--radius-md)",
    borderStyle: "solid",
    borderWidth: "1px",
    borderColor: "var(--color-accent)",
    backgroundColor: {
      default: "var(--color-accent)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-accent-hover)",
      },
    },
    paddingInline: "0.625rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    color: "var(--color-page)",
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
          <Icon
            name={props.removing === true ? "cross" : "check"}
            size={12}
            styles={props.removing === true ? viewStyles.keyMarkRemoving : viewStyles.keyMarkPresent}
          />
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
        <span {...stylex.attrs(props.small === true ? viewStyles.keyFieldLabelSmall : viewStyles.keyFieldLabelNormal)}>{props.label}</span>
        <KeyMark status={props.status} removing={props.removing} />
        <Show when={props.tip}>{(t) => <Hint text={t()} />}</Show>
        <span {...stylex.attrs(viewStyles.keyFieldSpan)} />
        <Show when={props.link}>{(l) => <OutLink href={l().href} label={l().label} />}</Show>
      </div>
      <div {...stylex.attrs(viewStyles.keyFieldDiv3)}>
        <div {...stylex.attrs(viewStyles.keyFieldControlWrap, props.removing && viewStyles.keyFieldControlRemoving)}>{props.children}</div>
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
