import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { For, omit } from "solid-js";

import { Select as Base } from "@vibevalley/base-ui";

import { Icon } from "./Icon";
import { positionerAttrs } from "./positioner";
import { Hint } from "./Tip";

const styles = stylex.create({
  box: {
    width: "100%",
    borderRadius: "var(--radius-md)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: { default: "var(--color-line)", ":focus": "var(--color-focus)" },
    backgroundColor: "var(--color-page)",
    paddingLeft: "calc(var(--spacing) * 2.5)",
    paddingRight: "calc(var(--spacing) * 2.5)",
    paddingBlock: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    outlineStyle: "none",
    color: { default: null, "::placeholder": "var(--color-faint)" },
  },
  input: { height: "calc(var(--spacing) * 8)" },
  textarea: { resize: "vertical" },
  label: { display: "flex", flexDirection: "column", gap: "var(--spacing)" },
  caption: {
    display: "flex",
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--text-xs--line-height)",
    fontWeight: "var(--font-weight-medium)",
    color: "var(--color-muted)",
  },
  trigger: {
    display: "flex",
    minWidth: 0,
    cursor: { default: "pointer", ":disabled": "default" },
    alignItems: "center",
    gap: "calc(var(--spacing) * 1.5)",
    borderRadius: "var(--radius-md)",
    borderWidth: 1,
    borderStyle: "solid",
    textAlign: "left",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    outlineStyle: "none",
    opacity: { default: null, ":disabled": 0.5 },
  },
  control: { height: "calc(var(--spacing) * 7)", paddingInline: "calc(var(--spacing) * 2)" },
  field: { height: "calc(var(--spacing) * 8)", paddingInline: "calc(var(--spacing) * 2.5)" },
  quiet: {
    borderColor: {
      default: "transparent",
      "@media (hover: hover)": { default: null, ":hover": "var(--color-line)" },
      ":is([data-popup-open])": "var(--color-line)",
    },
    backgroundColor: {
      default: "transparent",
      "@media (hover: hover)": { default: null, ":hover": "var(--color-page)" },
      ":is([data-popup-open])": "var(--color-page)",
    },
  },
  filter: {
    borderColor: "color-mix(in oklab, var(--color-accent) 40%, transparent)",
    backgroundColor: {
      default: "color-mix(in oklab, var(--color-accent) 8%, transparent)",
      "@media (hover: hover)": { default: null, ":hover": "color-mix(in oklab, var(--color-accent) 12%, transparent)" },
    },
  },
  normal: {
    borderColor: { default: "var(--color-line)", ":is([data-popup-open])": "var(--color-focus)" },
    backgroundColor: { default: "var(--color-page)", "@media (hover: hover)": { default: null, ":hover": "var(--color-hover)" } },
  },
  value: { minWidth: 0, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  chevron: { flexShrink: 0, color: "var(--color-muted)" },
  popup: {
    maxHeight: "calc(var(--spacing) * 72)",
    minWidth: "var(--anchor-width)",
    transformOrigin: "top",
    animationName: { default: "pop-in", "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "280ms",
    animationTimingFunction: "var(--ease-out)",
    animationFillMode: "both",
    overflowY: "auto",
    borderRadius: "var(--radius-lg)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: "var(--color-line)",
    backgroundColor: "var(--color-page)",
    padding: "var(--spacing)",
    boxShadow: "var(--shadow-float)",
    outlineStyle: "none",
  },
  item: {
    display: "flex",
    height: "calc(var(--spacing) * 7)",
    cursor: { default: "pointer", ":is([data-disabled])": "default" },
    alignItems: "center",
    gap: "calc(var(--spacing) * 2)",
    borderRadius: "var(--radius-md)",
    paddingInline: "calc(var(--spacing) * 2)",
    fontSize: "var(--text-sm)",
    lineHeight: "var(--text-sm--line-height)",
    outlineStyle: "none",
    opacity: { default: null, ":is([data-disabled])": 0.5 },
    backgroundColor: { default: null, ":is([data-highlighted])": "var(--color-hover)" },
    fontWeight: { default: null, ":is([data-selected])": "var(--font-weight-medium)" },
  },
  indicator: { display: "flex", flexShrink: 0, color: "var(--color-accent)" },
});

type ControlAppearance = { styles?: stylex.StyleXStyles; style?: JSX.CSSProperties | undefined };
export type TextInputProps = Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "class" | "style"> & ControlAppearance;

function controlAttrs(props: ControlAppearance, shape: stylex.StyleXStyles) {
  const appearance = stylex.props(styles.box, shape, props.styles);
  return { class: appearance.className, style: { ...appearance.style, ...props.style } };
}

export function TextInput(props: TextInputProps) {
  const rest = omit(props, "styles", "style");
  return <input {...rest} {...controlAttrs(props, styles.input)} />;
}

export function TextArea(props: Omit<JSX.TextareaHTMLAttributes<HTMLTextAreaElement>, "class" | "style"> & ControlAppearance) {
  const rest = omit(props, "styles", "style");
  return <textarea {...rest} {...controlAttrs(props, styles.textarea)} />;
}

/** A label over its control; what it means is behind an info icon beside the label. */
export function Field(props: { label: string; hint?: string | undefined; children: JSX.Element }) {
  return (
    <label {...stylex.attrs(styles.label)}>
      <span {...stylex.attrs(styles.caption)}>
        {props.label}
        {props.hint && <Hint text={props.hint} />}
      </span>
      {props.children}
    </label>
  );
}

/** value "" is the placeholder, and choosing it is choosing none (a placeholder needs a value type that holds ""). */
export function Select<V extends string>(props: {
  value: V;
  onChange: (v: V) => void;
  options: readonly { value: V; label: string; disabled?: boolean | undefined }[];
  placeholder?: ("" extends V ? string : never) | undefined;
  label: string;
  /** Placement only: width, margins. */
  styles?: stylex.StyleXStyles;
  testid?: string | undefined;
  quiet?: boolean;
  /** A filter that narrows: tinted while a value other than "" is chosen. */
  filter?: boolean;
  /** control: 28px, for a toolbar row; field (default): 32px, beside inputs. */
  size?: "control" | "field";
  disabled?: boolean | undefined;
  /** A choice on its way to the server (shown already) or refused (the value is the server's again). */
  state?: "pending" | "failed" | undefined;
}) {
  const all = () => [...(props.placeholder !== undefined ? [{ value: "", label: props.placeholder, disabled: false }] : []), ...props.options];
  const offered = (v: string): v is V => all().some((o) => o.value === v);
  const trigger = () =>
    stylex.props(
      styles.trigger,
      props.size === "control" ? styles.control : styles.field,
      props.quiet === true ? styles.quiet : props.filter === true && props.value !== "" ? styles.filter : styles.normal,
      props.styles,
    );
  return (
    <Base.Root value={props.value} onValueChange={(v) => offered(v) && props.onChange(v)} items={all()} disabled={props.disabled}>
      <Base.Trigger
        data-testid={props.testid}
        data-value={props.value}
        data-state={props.state}
        aria-busy={props.state === "pending" ? "true" : undefined}
        aria-label={props.label}
        class={trigger().className}
        style={trigger().style}
      >
        <Base.Value class={stylex.attrs(styles.value).class} placeholder={props.placeholder} />
        <Icon name="choose" size={12} styles={styles.chevron} />
      </Base.Trigger>
      <Base.Portal>
        <Base.Positioner {...positionerAttrs()} sideOffset={4}>
          <Base.Popup class={stylex.attrs(styles.popup).class}>
            <For each={all()}>
              {(o) => (
                <Base.Item value={o.value} data-key={o.value} disabled={o.disabled} class={stylex.attrs(styles.item).class}>
                  <span {...stylex.attrs(styles.value)}>{o.label}</span>
                  <Base.ItemIndicator class={stylex.attrs(styles.indicator).class}>
                    <Icon name="ticked" size={14} />
                  </Base.ItemIndicator>
                </Base.Item>
              )}
            </For>
          </Base.Popup>
        </Base.Positioner>
      </Base.Portal>
    </Base.Root>
  );
}
