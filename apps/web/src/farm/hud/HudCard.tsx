import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";

import { CardColors } from "#/ui/pixel/index.ts";

const viewStyles = stylex.create({
  hudCardOuter: {
    display: "inline-block",
    paddingRight: "calc(var(--spacing) * .5)",
    paddingBottom: "calc(var(--spacing) * .5)",
  },
  hudCardBox: {
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
  hudCardBright: {
    filter: "brightness(110%)",
  },
});

/** A wooden card the height of the HUD's row, an icon and words. */
export function HudCard(props: { height?: number; bright?: boolean; children: JSX.Element }) {
  return (
    <span {...stylex.attrs(viewStyles.hudCardOuter)}>
      <span
        {...stylex.attrs(viewStyles.hudCardBox, props.bright === true && viewStyles.hudCardBright)}
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
