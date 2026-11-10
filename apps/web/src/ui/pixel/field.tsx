import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { createEffect, createMemo, createSignal, createUniqueId, For, onSettled, Show, untrack } from "solid-js";

import { t } from "@vibevalley/i18n";

import { aria } from "#/base/dom.tsx";
import { spelled } from "#/base/search.ts";
import { styleProps } from "#/ui/positioner.ts";

import { PxWindow } from "./base";
import { SpriteIcon } from "./icons";
import { pxStyle } from "./style";

const styles = stylex.create({
  pxTextInputPxWindow: {
    position: "absolute",
    top: "100%",
    left: "-2px",
    zIndex: 20,
    marginTop: "calc(var(--spacing) * 1.5)",
    maxHeight: "calc(var(--spacing) * 60)",
    maxWidth: "calc(var(--spacing) * 80)",
    minWidth: "calc(var(--spacing) * 40)",
    overflowY: "auto",
    padding: "var(--spacing)",
  },
  tip: {
    cursor: "help",
    textDecorationLine: "underline",
    WebkitTextDecorationColor: "var(--color-bark-600)",
    textDecorationColor: "var(--color-bark-600)",
    textDecorationStyle: "dotted",
    textDecorationThickness: "2px",
  },
  inputBox: {
    borderWidth: 2,
    borderStyle: "solid",
    borderColor: { default: "var(--color-bark-500)", ":focus-within": "var(--color-leaf-500)" },
    backgroundColor: "var(--color-cream-input)",
  },
  input: {
    position: "relative",
    display: "flex",
    height: "calc(var(--spacing) * 9)",
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    paddingInline: "calc(var(--spacing) * 3)",
    color: "var(--color-bark-900)",
  },
  well: { backgroundColor: "var(--color-cream-100)" },
  disabled: { opacity: 0.5 },
  area: { display: "flex", paddingInline: "calc(var(--spacing) * 3)", paddingBlock: "calc(var(--spacing) * 2)" },
  control: {
    minWidth: 0,
    flex: "1",
    backgroundColor: "transparent",
    color: "var(--color-bark-900)",
    caretColor: "var(--color-bark-900)",
    outlineStyle: "none",
    "::placeholder": { color: "var(--color-bark-500)" },
  },
  areaControl: { resize: "none" },
  suggestion: { cursor: "pointer", paddingInline: "calc(var(--spacing) * 2.5)", paddingBlock: "calc(var(--spacing) * 1.5)", color: "var(--color-bark-800)" },
  highlighted: { backgroundColor: "var(--color-cream-200)" },
  pxFieldDiv: {
    display: "flex",
    flexDirection: "column",
  },
  pxFieldDiv2: {
    marginBottom: "calc(var(--spacing) * 1.5)",
    display: "flex",
    alignItems: "baseline",
    gap: "calc(var(--spacing) * 2)",
  },
  pxFieldLabel: {
    minWidth: "0",
    flex: "1",
    color: "var(--color-bark-600)",
  },
  pxFieldAside: {
    color: "var(--color-bark-500)",
  },
  pxFieldSpan: {
    color: "var(--color-leaf-300)",
  },
  pxFieldSpan2: {
    color: "var(--color-bark-500)",
  },
  pxFieldNote: {
    marginTop: "calc(var(--spacing) * 1.5)",
  },
  pxFieldHint: {
    color: "var(--color-bark-500)",
  },
  pxFieldError: {
    color: "var(--color-berry)",
  },
});

/** `label` with a dotted underline that shows `tip` on hover; the bare label without one. */
export function PxTip(props: { tip?: string | undefined; children: JSX.Element; styles?: stylex.StyleXStyles }) {
  return (
    <Show when={props.tip} fallback={<span {...styleProps(props.styles)}>{props.children}</span>}>
      <span title={props.tip} {...styleProps([styles.tip, props.styles])}>
        {props.children}
      </span>
    </Show>
  );
}

/**
 * A labelled field with a hint or an error under it. `children` may take the id the label points at, for a control
 * that is not the field's only focusable thing.
 */
export function PxField(props: {
  label: string;
  children: JSX.Element | ((id: string) => JSX.Element);
  id?: string;
  hint?: JSX.Element;
  /** What the field is for, shown when the label is hovered instead of a line under the field. */
  tip?: string;
  error?: string | undefined;
  aside?: JSX.Element;
  required?: boolean;
  optional?: boolean;
}) {
  const own = createUniqueId();
  const target = () => props.id ?? own;
  const bound = () => typeof props.children === "function" || props.id !== undefined;
  const note = () => (props.error ? props.error : props.hint);
  return (
    <div {...stylex.attrs(styles.pxFieldDiv)}>
      <div {...stylex.attrs(styles.pxFieldDiv2)}>
        <label for={bound() ? target() : undefined} {...stylex.attrs(pxStyle.xs, styles.pxFieldLabel)}>
          <PxTip tip={props.tip}>{props.label}</PxTip>
          <Show when={props.required}>
            <span {...stylex.attrs(styles.pxFieldSpan)}> *</span>
          </Show>
          <Show when={props.optional}>
            <span {...stylex.attrs(styles.pxFieldSpan2)}>{t("web.ui.pixel.optional")}</span>
          </Show>
        </label>
        <Show when={props.aside != null}>
          <div {...stylex.attrs(pxStyle.xs, styles.pxFieldAside)}>{props.aside}</div>
        </Show>
      </div>
      {typeof props.children === "function" ? props.children(target()) : props.children}
      <Show when={note() != null && note() !== ""}>
        <div
          {...stylex.attrs(pxStyle.xs, styles.pxFieldNote, props.error ? styles.pxFieldError : styles.pxFieldHint)}
          role={props.error ? "alert" : undefined}
        >
          {note()}
        </div>
      </Show>
    </div>
  );
}

/** Controlled. `suggestions` are offered while typing, those containing what is typed. */
export function PxTextInput(props: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  /** The accessible name where no PxField labels it. */
  label?: string;
  suggestions?: readonly string[];
  onSubmit?: (value: string) => void;
  autoFocus?: boolean;
  type?: string;
  inputMode?: "text" | "numeric" | "decimal" | "email" | "url" | "search" | "tel" | "none";
  /** Sunken in a cream well with the inner line, not framed: inside a card or a toolbar. */
  well?: boolean;
  icon?: string;
  id?: string;
  ref?: (el: HTMLInputElement) => void;
  styles?: stylex.StyleXStyles;
  testid?: string;
}) {
  const listId = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [highlight, setHighlight] = createSignal(-1);
  const suggestions = () => props.suggestions ?? [];
  const shown = createMemo(() => {
    const q = props.value.toLowerCase();
    return open() ? suggestions().filter((s) => spelled(s, q) && s !== props.value) : [];
  });
  const pick = (s: string) => {
    props.onChange(s);
    setOpen(false);
    setHighlight(-1);
  };
  const font = () => (props.mono === true ? pxStyle.mono : pxStyle.sm);
  let input: HTMLInputElement | undefined;
  onSettled(() => {
    if (props.autoFocus === true) input?.focus();
  });
  return (
    <div
      {...styleProps([
        styles.input,
        props.well === true ? [styles.well, pxStyle.ring] : styles.inputBox,
        props.disabled === true && styles.disabled,
        props.styles,
      ])}
    >
      <Show when={props.icon}>{(icon) => <SpriteIcon name={icon()} size={14} />}</Show>
      <input
        data-testid={props.testid}
        ref={(el) => {
          input = el;
          props.ref?.(el);
        }}
        id={props.id}
        type={props.type ?? "text"}
        inputmode={props.inputMode}
        value={props.value}
        disabled={props.disabled}
        placeholder={props.placeholder}
        aria-label={props.label}
        role={suggestions().length > 0 ? "combobox" : undefined}
        aria-autocomplete={suggestions().length > 0 ? "list" : undefined}
        aria-expanded={suggestions().length > 0 ? aria(shown().length > 0) : undefined}
        aria-controls={shown().length > 0 ? listId : undefined}
        aria-activedescendant={shown().length > 0 && highlight() >= 0 ? `${listId}-${highlight()}` : undefined}
        onInput={(e) => {
          props.onChange(e.currentTarget.value);
          setOpen(true);
          setHighlight(-1);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          const n = shown().length;
          if (n > 0 && e.key === "ArrowDown") setHighlight((h) => (h + 1) % n);
          else if (n > 0 && e.key === "ArrowUp") setHighlight((h) => (h <= 0 ? n - 1 : h - 1));
          else if (n > 0 && e.key === "Escape") setOpen(false);
          else if (e.key === "Enter" && !e.isComposing) {
            const s = highlight() >= 0 ? shown()[highlight()] : undefined;
            if (s !== undefined) pick(s);
            else props.onSubmit?.(props.value);
          } else return;
          e.preventDefault();
        }}
        {...stylex.attrs(font(), styles.control)}
      />
      <Show when={shown().length > 0}>
        <PxWindow styles={[styles.pxTextInputPxWindow]}>
          <ul id={listId} role="listbox" aria-label={props.label}>
            <For each={shown()}>
              {(s, i) => (
                <li
                  id={`${listId}-${i()}`}
                  role="option"
                  aria-selected={aria(i() === highlight())}
                  // Down, not click: the input keeps the focus, so the list is still there when the click lands.
                  onMouseDown={(e) => {
                    e.preventDefault();
                    pick(s);
                  }}
                  onMouseEnter={() => setHighlight(i())}
                  {...stylex.attrs(font(), styles.suggestion, i() === highlight() && styles.highlighted)}
                >
                  {s}
                </li>
              )}
            </For>
          </ul>
        </PxWindow>
      </Show>
    </div>
  );
}

/** Controlled, `rows` lines tall. */
export function PxTextArea(props: {
  value: string;
  onChange: (value: string) => void;
  rows?: number;
  placeholder?: string;
  disabled?: boolean;
  readOnly?: boolean;
  mono?: boolean;
  /** A long text being written (an issue's description): in pxStyle.read, as it is read. */
  reading?: boolean;
  label?: string;
  autoFocus?: boolean;
  /** What is selected when `value` is replaced from outside (a blank to fill in), as [start, end]; the cursor goes to the end without it. */
  selection?: readonly [number, number] | undefined;
  id?: string;
  ref?: (el: HTMLTextAreaElement) => void;
  styles?: stylex.StyleXStyles;
}) {
  let area: HTMLTextAreaElement | undefined;
  let typed = untrack(() => props.value);
  createEffect(
    () => [props.value, props.selection] as const,
    ([value, selection]) => {
      if (!area || value === typed) return;
      typed = value;
      const [start, end] = selection ?? [value.length, value.length];
      area.setSelectionRange(start, end);
    },
  );
  onSettled(() => {
    if (props.autoFocus === true) area?.focus();
  });
  return (
    <div {...styleProps([styles.area, styles.inputBox, props.disabled === true && styles.disabled, props.styles])}>
      <textarea
        ref={(t) => {
          area = t;
          props.ref?.(t);
        }}
        id={props.id}
        rows={props.rows ?? 6}
        value={props.value}
        disabled={props.disabled}
        readonly={props.readOnly}
        placeholder={props.placeholder}
        aria-label={props.label}
        onInput={(e) => {
          typed = e.currentTarget.value;
          props.onChange(e.currentTarget.value);
        }}
        {...stylex.attrs(props.reading === true ? pxStyle.read : props.mono === true ? pxStyle.mono : pxStyle.sm, styles.control, styles.areaControl)}
      />
    </div>
  );
}
