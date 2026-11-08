import * as stylex from "@stylexjs/stylex";
import { omit } from "solid-js";

import { Checkbox as Base } from "@vibevalley/base-ui";

import { Icon } from "./Icon";

const variantStyles = stylex.create({
  box: {
    display: "flex",
    width: "calc(var(--spacing) * 4)",
    height: "calc(var(--spacing) * 4)",
    flexShrink: 0,
    cursor: { default: "pointer", ":disabled": "default" },
    alignItems: "center",
    justifyContent: "center",
    borderRadius: "var(--radius-xs)",
    borderWidth: 1,
    borderStyle: "solid",
    borderColor: {
      default: "var(--color-line)",
      ":is([data-checked], [data-indeterminate])": "var(--color-accent)",
      "@media (hover: hover)": { default: null, ":hover:not([data-checked]):not([data-indeterminate])": "var(--color-muted)" },
    },
    backgroundColor: { default: "var(--color-page)", ":is([data-checked], [data-indeterminate])": "var(--color-accent)" },
    color: "var(--color-page)",
    transitionProperty: "color, background-color, border-color, outline-color, text-decoration-color, fill, stroke",
    transitionDuration: "120ms",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    opacity: { default: null, ":disabled": 0.5 },
  },
  checkboxBaseIndicator: {
    display: "flex",
  },
});

/** A box to tick (base-ui's Checkbox): the same box on every system and in both themes, ticked in the accent colour. */
export function Checkbox(props: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  indeterminate?: boolean;
  disabled?: boolean;
  testid?: string;
  /** Placement only. */
  styles?: stylex.StyleXStyles;
  "data-key"?: string | number;
}) {
  const rest = omit(props, "checked", "onChange", "label", "indeterminate", "disabled", "testid", "styles");
  const appearance = () => {
    const { className, ...attributes } = stylex.props(variantStyles.box, props.styles);
    return { ...attributes, class: className };
  };
  return (
    <Base.Root
      {...rest}
      checked={props.checked}
      onCheckedChange={props.onChange}
      indeterminate={props.indeterminate}
      disabled={props.disabled}
      aria-label={props.label}
      data-testid={props.testid}
      {...appearance()}
    >
      <Base.Indicator {...stylex.attrs(variantStyles.checkboxBaseIndicator)}>
        <Icon name={props.indeterminate === true ? "partly" : "ticked"} size={12} />
      </Base.Indicator>
    </Base.Root>
  );
}
