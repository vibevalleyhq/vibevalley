import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";

import { cx } from "./cx";

const styles = stylex.create({ floating: { zIndex: 30 } });

/** Object styles preserve the compiler's case-sensitive custom property names. */
export function styleProps(values: stylex.StyleXArray<stylex.StyleXStyles | stylex.CompiledStyles>, inline?: JSX.CSSProperties) {
  const { className, style, ...attributes } = stylex.props(values);
  return { ...attributes, class: className, style: inline === undefined ? style : { ...style, ...inline } };
}

export function positionerAttrs(...values: readonly stylex.StyleXStyles[]) {
  // Base UI merges object styles with its coordinates; attrs() would serialize and lose these variables.
  return styleProps([styles.floating, values]);
}

/**
 * A part already on Tailwind classes that still takes StyleX `styles` from a caller not yet moved off StyleX
 * (vv-tailwind). StyleX's layer is above Tailwind's (style.css), so the caller's styles still win over the part's classes
 * as they did. Goes away with the last caller that passes `styles`.
 */
export function withStyles(styles: stylex.StyleXStyles | undefined, classes: JSX.ClassValue, inline?: JSX.CSSProperties) {
  if (styles === undefined) return { class: cx(classes), style: inline };
  const { className, style } = stylex.props(styles);
  return { class: cx(classes, className), style: inline === undefined ? style : { ...style, ...inline } };
}
