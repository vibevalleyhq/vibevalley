import * as stylex from "@stylexjs/stylex";

const styles = stylex.create({ floating: { zIndex: 30 } });

export function positionerAttrs(...values: readonly stylex.StyleXStyles[]) {
  // Base UI merges object styles with its coordinates; attrs() would serialize and lose these variables.
  const { className, ...attributes } = stylex.props(styles.floating, values);
  return { ...attributes, class: className };
}
