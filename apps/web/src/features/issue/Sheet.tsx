import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";

import { aria } from "#/base/dom.tsx";
import { Select } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";
import { styleProps } from "#/ui/positioner.ts";

import type { Tone } from "./cards";
import { type Stage, stageLabel, stages } from "./issue";
import { toneVar } from "./Marks";

const styles = stylex.create({
  issueSheetAside: {
    display: "flex",
    flexDirection: "column",
    borderRadius: {
      default: "var(--radius-lg)",
      "@container (width>=760px)": "0",
    },
    backgroundColor: {
      default: "var(--wb-hover)",
      "@container (width>=760px)": "transparent",
    },
    paddingTop: {
      default: "0.75rem",
      "@container (width>=760px)": "0",
    },
    paddingRight: {
      default: "0.75rem",
      "@container (width>=760px)": "0",
    },
    paddingBottom: {
      default: "0.75rem",
      "@container (width>=760px)": "0",
    },
    paddingLeft: {
      default: "0.75rem",
      "@container (width>=760px)": "1.25rem",
    },
    width: {
      default: null,
      "@container (width>=760px)": "260px",
    },
    flexShrink: {
      default: null,
      "@container (width>=760px)": "0",
    },
    borderLeftStyle: {
      default: null,
      "@container (width>=760px)": "solid",
    },
    borderLeftWidth: {
      default: null,
      "@container (width>=760px)": "1px",
    },
    borderColor: {
      default: null,
      "@container (width>=760px)": "var(--wb-line)",
    },
  },
  stagesSpanState: {
    color: "var(--wb-faint)",
    fontWeight: null,
  },
  stagesSpanState2: {
    color: "var(--wb-accent)",
    fontWeight: null,
  },
  stagesSpanState3: {
    color: "var(--wb-ink)",
    fontWeight: "var(--font-weight-semibold)",
  },
  issueSheetDiv: {
    marginTop: "1rem",
    display: "flex",
    flexDirection: {
      default: "column",
      "@container (width>=760px)": "row",
    },
    gap: {
      default: "1rem",
      "@container (width>=760px)": "1.5rem",
    },
    alignItems: {
      default: null,
      "@container (width>=760px)": "flex-start",
    },
  },
  foldIcon: {
    transitionProperty: "rotate",
    transitionTimingFunction: "var(--ease-out)",
    transitionDuration: "180ms",
  },
  foldIconTone: {
    rotate: "90deg",
  },
  foldIconAlt: {},
  stagesDiv: {
    display: "flex",
    alignItems: "center",
  },
  stagesDivTone: {
    flex: "1",
  },
  stagesDivAlt: {},
  stagesDiv2: {
    marginInline: "0.5rem",
    height: "1px",
    flex: "1",
  },
  stagesDivAccent: {
    backgroundColor: "var(--color-leaf)",
  },
  stagesDivMuted: {
    backgroundColor: "var(--color-line)",
  },
  stagesSpan: {
    width: "0.5rem",
    height: "0.5rem",
    borderRadius: "9999px",
  },
  stagesSpanTone: {
    backgroundColor: "var(--color-wheat)",
  },
  note: {
    borderRadius: "var(--radius-lg)",
    paddingInline: "0.875rem",
    paddingBlock: "0.75rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  issueSheetDiv2: {
    containerType: "inline-size",
  },
  issueSheetDiv22: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
  },
  propertyDiv: {
    display: "flex",
    minHeight: "2rem",
    alignItems: "center",
    gap: "0.75rem",
    paddingBlock: "0.125rem",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  propertySpan: {
    width: "4rem",
    flexShrink: "0",
    color: "var(--color-muted)",
  },
  propertyDiv2: {
    minWidth: "0",
    flex: "1",
    overflowWrap: "break-word",
  },
  foldDiv: {
    borderBottomStyle: {
      default: "solid",
      ":last-child": "solid",
    },
    borderBottomWidth: {
      default: "1px",
      ":last-child": "0",
    },
    borderColor: "var(--color-line)",
  },
  foldButton: {
    display: "flex",
    width: "100%",
    cursor: "pointer",
    alignItems: "center",
    gap: "0.5rem",
    paddingBlock: "0.625rem",
    textAlign: "left",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-hover)",
      },
    },
  },
  foldSpan: {
    flexShrink: "0",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
    fontWeight: "var(--font-weight-semibold)",
  },
  foldSpan2: {
    minWidth: "0",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: "var(--color-muted)",
  },
  foldDiv2: {
    paddingBottom: "0.75rem",
    paddingLeft: "1.25rem",
  },
  moreDiv: {
    marginTop: "0.25rem",
  },
  moreButton: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "0.375rem",
    paddingBlock: "0.25rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    color: {
      default: "var(--color-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--color-ink)",
      },
    },
  },
  sheetLabelDiv: {
    marginTop: "1.5rem",
    marginBottom: "0.375rem",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-xs)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--color-muted)",
  },
  stagesDiv3: {
    display: "flex",
    alignItems: "center",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--leading-sm)",
  },
  stagesSpan2: {
    display: "flex",
    alignItems: "center",
    gap: "0.375rem",
    whiteSpace: "nowrap",
  },
});

/** An issue laid out as a page: what it is and the talk about it on the left, its properties and actions on the right. */
export function IssueSheet(props: { heading: JSX.Element; main: JSX.Element; side: JSX.Element }) {
  return (
    <div {...stylex.attrs(styles.issueSheetDiv2)}>
      {props.heading}
      <div {...stylex.attrs(styles.issueSheetDiv)}>
        <div {...stylex.attrs(styles.issueSheetDiv22)}>{props.main}</div>
        <aside {...stylex.attrs(styles.issueSheetAside)}>{props.side}</aside>
      </div>
    </div>
  );
}

/** A label and its value, the label in a narrow muted column. */
export function Property(props: { label: string; children: JSX.Element }) {
  return (
    <div {...stylex.attrs(styles.propertyDiv)}>
      <span {...stylex.attrs(styles.propertySpan)}>{props.label}</span>
      <div {...stylex.attrs(styles.propertyDiv2)}>{props.children}</div>
    </div>
  );
}

/** A second-level part: folded until asked for, its summary beside the label. */
export function Fold(props: { label: string; summary?: string | undefined; open?: boolean; leading?: JSX.Element; children: JSX.Element }) {
  const [open, setOpen] = createSignal(untrack(() => props.open ?? false));
  return (
    <div {...stylex.attrs(styles.foldDiv)}>
      <button type="button" aria-expanded={aria(open())} onClick={() => setOpen(!open())} {...stylex.attrs(styles.foldButton)}>
        <Icon name="expand" size={10} styles={[styles.foldIcon, open() ? styles.foldIconTone : styles.foldIconAlt]} />
        {props.leading}
        <span {...stylex.attrs(styles.foldSpan)}>{props.label}</span>
        <Show when={props.summary}>
          <span {...stylex.attrs(styles.foldSpan2)}>{props.summary}</span>
        </Show>
      </button>
      {/* Mounted with the page and only hidden while folded. */}
      <div {...stylex.attrs(styles.foldDiv2)} hidden={!open()}>
        {props.children}
      </div>
    </div>
  );
}

/** The properties asked about less often, behind More. */
export function More(props: { children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div {...stylex.attrs(styles.moreDiv)}>
      <button type="button" onClick={() => setOpen(!open())} {...stylex.attrs(styles.moreButton)}>
        <Icon name="expand" size={10} styles={[styles.foldIconAlt, open() ? styles.foldIconTone : styles.foldIconAlt]} />
        {open() ? t("web.issue.sheet.less") : t("web.issue.sheet.more")}
      </button>
      <Show when={open()}>
        <div {...stylex.attrs(styles.moreDiv)}>{props.children}</div>
      </Show>
    </div>
  );
}

export function SheetLabel(props: { children: JSX.Element }) {
  return <div {...stylex.attrs(styles.sheetLabelDiv)}>{props.children}</div>;
}

/** A tinted box: the status, a conflict, nothing to merge. */
export function Note(props: { tone?: Tone; children: JSX.Element; styles?: stylex.StyleXStyles }) {
  return (
    <div
      {...styleProps([styles.note, props.styles], {
        background: props.tone ? `color-mix(in srgb, ${toneVar(props.tone)} 16%, transparent)` : "var(--color-hover)",
      })}
    >
      {props.children}
    </div>
  );
}

/** Draft -> Active -> Done, the one it is at marked. */
export function Stages(props: { at: Stage }) {
  const ati = () => stages.indexOf(props.at);
  return (
    <div {...stylex.attrs(styles.stagesDiv3)} aria-label={t("web.issue.sheet.at", { stage: stageLabel[props.at] })}>
      <For each={stages}>
        {(s, i) => (
          <div {...stylex.attrs(styles.stagesDiv, i() > 0 ? styles.stagesDivTone : styles.stagesDivAlt)}>
            <Show when={i() > 0}>
              <div {...stylex.attrs(styles.stagesDiv2, i() <= ati() ? styles.stagesDivAccent : styles.stagesDivMuted)} />
            </Show>
            <span {...stylex.attrs(styles.stagesSpan2)}>
              <Show
                when={i() < ati()}
                fallback={
                  <span {...stylex.attrs(styles.stagesSpan, s === props.at ? styles.stagesSpanTone : styles.stagesDivMuted)} />
                }
              >
                <Icon name="check" size={12} label={t("web.issue.sheet.stageDone", { stage: stageLabel[s] })} />
              </Show>
              <span
                {...stylex.attrs(
                  s === props.at ? styles.stagesSpanState3 : i() < ati() ? styles.stagesSpanState2 : styles.stagesSpanState,
                )}
              >
                {stageLabel[s]}
              </span>
            </span>
          </div>
        )}
      </For>
    </div>
  );
}

const selectStyles = stylex.create({ property: { marginLeft: "-0.5rem", width: "calc(100% + 8px)" } });

export function Pick<V extends string>(props: {
  label: string;
  value: V;
  options: readonly { value: V; label: string }[];
  placeholder?: "" extends V ? string : never;
  onChange: (v: V) => void;
  disabled?: boolean;
  testid?: string;
  state?: "pending" | "failed" | undefined;
}) {
  return (
    <Select
      quiet
      size="control"
      styles={selectStyles.property}
      label={props.label}
      value={props.value}
      options={props.options}
      placeholder={props.placeholder}
      onChange={props.onChange}
      disabled={props.disabled}
      testid={props.testid}
      state={props.state}
    />
  );
}
