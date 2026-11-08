import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";

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
