import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";

import { styleProps } from "#/ui/positioner.ts";

const styles = stylex.create({
  outer: {
    display: "inline-block",
    paddingRight: "calc(var(--spacing) * .5)",
    paddingBottom: "calc(var(--spacing) * .5)",
  },
  box: {
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing)",
    borderStyle: "solid",
    borderWidth: "2px",
    borderColor: "var(--color-bark-850)",
    backgroundColor: "var(--color-glow-soft)",
    paddingInline: "calc(var(--spacing) * 2)",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
    color: "var(--color-bark-850)",
    boxShadow: "var(--shadow-px-shade)",
  },
  height: (height: number) => ({ height }),
  bright: {
    filter: "brightness(110%)",
  },
});

/** A wooden card the height of the HUD's row, an icon and words. */
export function HudCard(props: { height?: number; bright?: boolean; children: JSX.Element }) {
  return (
    <span {...stylex.attrs(styles.outer)}>
      <span {...styleProps([styles.box, props.bright === true && styles.bright, props.height !== undefined && styles.height(props.height)])}>
        {props.children}
      </span>
    </span>
  );
}
