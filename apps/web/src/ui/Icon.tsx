import * as stylex from "@stylexjs/stylex";

import { type IconName, icons } from "./icons";

// The size ladder (docs/style/design.md).
export type IconSize = 10 | 12 | 14 | 16 | 20 | 24 | 48;

const styles = stylex.create({
  icon: { display: "inline-flex", flexShrink: 0 },
  met: { color: "var(--color-leaf)" },
  unmet: { color: "var(--color-berry)" },
  unsure: { color: "var(--color-wheat)" },
});

/** The marks keep their colour wherever they stand: met is green, unmet red, unsure amber. */
const iconTone: Partial<Record<IconName, stylex.StyleXStyles>> = { check: styles.met, cross: styles.unmet, warn: styles.unsure };

export function Icon(props: { name: IconName; size?: IconSize; label?: string; styles?: stylex.StyleXStyles }) {
  const appearance = () => stylex.props(styles.icon, props.styles, iconTone[props.name]);
  return (
    <span
      role={props.label ? "img" : undefined}
      aria-label={props.label}
      aria-hidden={props.label ? undefined : "true"}
      class={appearance().className}
      style={appearance().style}
    >
      {icons[props.name]({ size: props.size ?? 16 })}
    </span>
  );
}
