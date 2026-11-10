import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";

import { Tooltip } from "@vibevalley/base-ui";

import { Icon } from "./Icon";
import type { IconName } from "./icons";
import { positionerAttrs } from "./positioner";

const delay = 300;
const styles = stylex.create({
  trigger: { display: "inline-flex" },
  bubble: {
    width: "max-content",
    maxWidth: "calc(var(--spacing) * 72)",
    animationName: { default: "fade-in", "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "180ms",
    animationTimingFunction: "var(--ease-out)",
    animationFillMode: "both",
    borderRadius: "var(--radius-md)",
    backgroundColor: "var(--color-ink)",
    paddingInline: "calc(var(--spacing) * 2)",
    paddingBlock: "var(--spacing)",
    fontSize: "var(--text-xs)",
    lineHeight: "var(--leading-snug)",
    fontWeight: "var(--font-weight-normal)",
    whiteSpace: "normal",
    color: "var(--color-page)",
    boxShadow: "var(--shadow-float)",
  },
  hint: {
    display: "inline-flex",
    cursor: "help",
    borderRadius: "var(--radius-sm)",
    color: "var(--color-faint)",
    opacity: { default: 0.5, "@media (hover: hover)": { default: null, ":hover": 1 }, ":focus-visible": 1 },
    transitionProperty: "opacity",
    transitionDuration: "120ms",
    transitionTimingFunction: "var(--default-transition-timing-function)",
    outlineStyle: "none",
    outlineWidth: { default: null, ":focus-visible": 2 },
    outlineColor: { default: null, ":focus-visible": "var(--color-focus)" },
  },
});

function Bubble(props: { text: string }) {
  return (
    <Tooltip.Portal>
      <Tooltip.Positioner {...positionerAttrs()} sideOffset={6}>
        <Tooltip.Popup {...stylex.attrs(styles.bubble)}>{props.text}</Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  );
}

export function Tip(props: { text: string; children: JSX.Element }) {
  return (
    <Tooltip.Root delay={delay}>
      <Tooltip.Trigger render="span" {...stylex.attrs(styles.trigger)}>
        {props.children}
      </Tooltip.Trigger>
      <Bubble text={props.text} />
    </Tooltip.Root>
  );
}

/** An info icon that says `text` on hover or focus; it describes, it does not label (a field's label stays its own). */
/** icon: info for what a thing is; another for a fact of another kind beside it (where the settings are kept). */
export function Hint(props: { text: string; icon?: IconName }) {
  return (
    <Tooltip.Root delay={delay}>
      <Tooltip.Trigger
        render="span"
        tabindex={0}
        // A form of ten fields should not read as ten marks: help stays out of the way.
        {...stylex.attrs(styles.hint)}
      >
        <Icon name={props.icon ?? "info"} size={12} />
      </Tooltip.Trigger>
      <Bubble text={props.text} />
    </Tooltip.Root>
  );
}
