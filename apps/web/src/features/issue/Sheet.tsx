import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createSignal, For, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";

import { aria } from "#/base/dom.tsx";
import { Select } from "#/ui/Field.tsx";
import { Icon } from "#/ui/Icon.tsx";

import type { Tone } from "./cards";
import { type Stage, stageLabel, stages } from "./issue";
import { toneVar } from "./Marks";

const recipeStyles = stylex.create({
  issueSheetDiv: {
    marginTop: "calc(var(--spacing) * 4)",
    display: "flex",
    flexDirection: {
      default: "column",
      "@container (width>=760px)": "row",
    },
    gap: {
      default: "calc(var(--spacing) * 4)",
      "@container (width>=760px)": "calc(var(--spacing) * 6)",
    },
    alignItems: {
      default: null,
      "@container (width>=760px)": "flex-start",
    },
  },
});

const variantStyles2 = stylex.create({
  foldIcon: {
    transitionProperty: "transform,translate,scale,rotate",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    transitionDuration: "var(--default-transition-duration)",
  },
  foldIconVariant: {
    rotate: "90deg",
  },
  foldIconVariant2: {},
});

const variantStyles = stylex.create({
  stagesDiv: {
    display: "flex",
    alignItems: "center",
  },
  stagesDivVariant: {
    flex: "1",
  },
  stagesDivVariant2: {},
  stagesDiv2: {
    marginInline: "calc(var(--spacing) * 2)",
    height: "1px",
    flex: "1",
  },
  stagesDivVariant3: {
    backgroundColor: "var(--wb-leaf)",
  },
  stagesDivVariant4: {
    backgroundColor: "var(--wb-line)",
  },
  stagesSpan: {
    width: "calc(var(--spacing) * 2)",
    height: "calc(var(--spacing) * 2)",
    borderRadius: "2147483647px",
  },
  stagesSpanVariant: {
    backgroundColor: "var(--wb-wheat)",
  },
});

const viewStyles = stylex.create({
  issueSheetDiv: {
    containerType: "inline-size",
  },
  issueSheetDiv2: {
    display: "flex",
    minWidth: "0",
    flex: "1",
    flexDirection: "column",
  },
  propertyDiv: {
    display: "flex",
    minHeight: "calc(var(--spacing) * 8)",
    alignItems: "center",
    gap: "calc(var(--spacing) * 3)",
    paddingBlock: "calc(var(--spacing) * .5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  propertySpan: {
    width: "calc(var(--spacing) * 16)",
    flexShrink: "0",
    color: "var(--wb-muted)",
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
    borderColor: "var(--wb-line)",
  },
  foldButton: {
    display: "flex",
    width: "100%",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    paddingBlock: "calc(var(--spacing) * 2.5)",
    textAlign: "left",
    backgroundColor: {
      default: null,
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-hover)",
      },
    },
  },
  foldSpan: {
    flexShrink: "0",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    fontWeight: "var(--font-weight-semibold)",
  },
  foldSpan2: {
    minWidth: "0",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    overflow: "hidden",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: "var(--wb-muted)",
  },
  foldDiv2: {
    paddingBottom: "calc(var(--spacing) * 3)",
    paddingLeft: "calc(var(--spacing) * 5)",
  },
  moreDiv: {
    marginTop: "var(--spacing)",
  },
  moreButton: {
    display: "flex",
    cursor: "pointer",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    paddingBlock: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    color: {
      default: "var(--wb-muted)",
      "@media (hover:hover)": {
        default: null,
        ":hover": "var(--wb-ink)",
      },
    },
  },
  sheetLabelDiv: {
    marginTop: "calc(var(--spacing) * 6)",
    marginBottom: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-semibold)",
    color: "var(--wb-muted)",
  },
  stagesDiv: {
    display: "flex",
    alignItems: "center",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
  },
  stagesSpan: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    whiteSpace: "nowrap",
  },
});

/** An issue laid out as a page: what it is and the talk about it on the left, its properties and actions on the right. */
export function IssueSheet(props: { heading: JSX.Element; main: JSX.Element; side: JSX.Element }) {
  return (
    <div {...stylex.attrs(viewStyles.issueSheetDiv)}>
      {props.heading}
      <div {...stylex.attrs(recipeStyles.issueSheetDiv)}>
        <div {...stylex.attrs(viewStyles.issueSheetDiv2)}>{props.main}</div>
        <aside class="flex flex-col rounded-lg bg-hover p-3 @min-[760px]:w-[260px] @min-[760px]:shrink-0 @min-[760px]:rounded-none @min-[760px]:border-l @min-[760px]:border-line @min-[760px]:bg-transparent @min-[760px]:py-0 @min-[760px]:pr-0 @min-[760px]:pl-5">
          {props.side}
        </aside>
      </div>
    </div>
  );
}

/** A label and its value, the label in a narrow muted column. */
export function Property(props: { label: string; children: JSX.Element }) {
  return (
    <div {...stylex.attrs(viewStyles.propertyDiv)}>
      <span {...stylex.attrs(viewStyles.propertySpan)}>{props.label}</span>
      <div {...stylex.attrs(viewStyles.propertyDiv2)}>{props.children}</div>
    </div>
  );
}

/** A second-level part: folded until asked for, its summary beside the label. */
export function Fold(props: { label: string; summary?: string | undefined; open?: boolean; leading?: JSX.Element; children: JSX.Element }) {
  const [open, setOpen] = createSignal(untrack(() => props.open ?? false));
  return (
    <div {...stylex.attrs(viewStyles.foldDiv)}>
      <button type="button" aria-expanded={aria(open())} onClick={() => setOpen(!open())} {...stylex.attrs(viewStyles.foldButton)}>
        <Icon name="expand" size={10} styles={[variantStyles2.foldIcon, open() ? variantStyles2.foldIconVariant : variantStyles2.foldIconVariant2]} />
        {props.leading}
        <span {...stylex.attrs(viewStyles.foldSpan)}>{props.label}</span>
        <Show when={props.summary}>
          <span {...stylex.attrs(viewStyles.foldSpan2)}>{props.summary}</span>
        </Show>
      </button>
      {/* Mounted with the page and only hidden while folded. */}
      <div {...stylex.attrs(viewStyles.foldDiv2)} hidden={!open()}>
        {props.children}
      </div>
    </div>
  );
}

/** The properties asked about less often, behind More. */
export function More(props: { children: JSX.Element }) {
  const [open, setOpen] = createSignal(false);
  return (
    <div {...stylex.attrs(viewStyles.moreDiv)}>
      <button type="button" onClick={() => setOpen(!open())} {...stylex.attrs(viewStyles.moreButton)}>
        <Icon name="expand" size={10} styles={[variantStyles2.foldIconVariant2, open() ? variantStyles2.foldIconVariant : variantStyles2.foldIconVariant2]} />
        {open() ? t("web.issue.sheet.less") : t("web.issue.sheet.more")}
      </button>
      <Show when={open()}>
        <div {...stylex.attrs(viewStyles.moreDiv)}>{props.children}</div>
      </Show>
    </div>
  );
}

export function SheetLabel(props: { children: JSX.Element }) {
  return <div {...stylex.attrs(viewStyles.sheetLabelDiv)}>{props.children}</div>;
}

/** A tinted box: the status, a conflict, nothing to merge. */
export function Note(props: { tone?: Tone; children: JSX.Element; class?: string }) {
  return (
    <div
      class={["rounded-lg px-3.5 py-3 text-sm", props.class]}
      style={{ background: props.tone ? `color-mix(in srgb, ${toneVar(props.tone)} 16%, transparent)` : "var(--color-hover)" }}
    >
      {props.children}
    </div>
  );
}

/** Draft -> Active -> Done, the one it is at marked. */
export function Stages(props: { at: Stage }) {
  const ati = () => stages.indexOf(props.at);
  return (
    <div {...stylex.attrs(viewStyles.stagesDiv)} aria-label={t("web.issue.sheet.at", { stage: stageLabel[props.at] })}>
      <For each={stages}>
        {(s, i) => (
          <div {...stylex.attrs(variantStyles.stagesDiv, i() > 0 ? variantStyles.stagesDivVariant : variantStyles.stagesDivVariant2)}>
            <Show when={i() > 0}>
              <div {...stylex.attrs(variantStyles.stagesDiv2, i() <= ati() ? variantStyles.stagesDivVariant3 : variantStyles.stagesDivVariant4)} />
            </Show>
            <span {...stylex.attrs(viewStyles.stagesSpan)}>
              <Show
                when={i() < ati()}
                fallback={
                  <span {...stylex.attrs(variantStyles.stagesSpan, s === props.at ? variantStyles.stagesSpanVariant : variantStyles.stagesDivVariant4)} />
                }
              >
                <Icon name="check" size={12} label={t("web.issue.sheet.stageDone", { stage: stageLabel[s] })} />
              </Show>
              <span class={s === props.at ? "font-semibold text-ink" : i() < ati() ? "text-accent" : "text-faint"}>{stageLabel[s]}</span>
            </span>
          </div>
        )}
      </For>
    </div>
  );
}

const selectStyles = stylex.create({ property: { marginLeft: "calc(var(--spacing) * -2)", width: "calc(100% + 8px)" } });

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
