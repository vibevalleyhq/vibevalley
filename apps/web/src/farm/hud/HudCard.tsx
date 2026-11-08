import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";

import { CardColors } from "#/ui/pixel/index.ts";

const variantStyles = stylex.create({
  hudCardSpan: {
    boxSizing: "border-box",
    display: "flex",
    alignItems: "center",
    gap: "var(--spacing)",
    borderStyle: "solid",
    borderWidth: "2px",
    paddingInline: "calc(var(--spacing) * 2)",
    fontFamily: "var(--font-pixel)",
    fontSize: "12px",
  },
  hudCardSpanVariant: {
    filter: "brightness(110%)",
  },
  hudCardSpanVariant2: {},
});

const viewStyles = stylex.create({
  hudCardSpan: {
    display: "inline-block",
    paddingRight: "calc(var(--spacing) * .5)",
    paddingBottom: "calc(var(--spacing) * .5)",
  },
});

/** A wooden card the height of the HUD's row, an icon and words. */
export function HudCard(props: { height?: number; bright?: boolean; children: JSX.Element }) {
  return (
    <span {...stylex.attrs(viewStyles.hudCardSpan)}>
      <span
        {...stylex.attrs(variantStyles.hudCardSpan, !(props.bright !== true) ? variantStyles.hudCardSpanVariant : variantStyles.hudCardSpanVariant2)}
        style={{
          height: props.height !== undefined ? `${props.height}px` : undefined,
          background: CardColors.paper,
          "border-color": CardColors.ink,
          color: CardColors.ink,
          "box-shadow": "2px 2px 0 0 #3a2a1899",
        }}
      >
        {props.children}
      </span>
    </span>
  );
}
