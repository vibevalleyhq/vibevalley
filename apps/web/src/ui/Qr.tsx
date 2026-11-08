import * as stylex from "@stylexjs/stylex";
import { createMemo } from "solid-js";
import { renderSVG } from "uqr";

import { styleProps } from "./positioner";

const styles = stylex.create({
  code: { display: "block", backgroundColor: "var(--color-white)" },
  size: (size: number) => ({ width: size, height: size }),
  svg: { width: "100%", height: "100%" },
});

/** A QR code of text, black on white with its quiet zone. The svg is parsed into a node, without innerHTML. */
export function Qr(props: { text: string; size?: number; label: string }) {
  const svg = createMemo(() => {
    const node = new DOMParser().parseFromString(renderSVG(props.text, { border: 2 }), "image/svg+xml").documentElement;
    node.setAttribute("class", stylex.attrs(styles.svg).class ?? "");
    return node;
  });
  return (
    <span role="img" aria-label={props.label} {...styleProps([styles.code, styles.size(props.size ?? 208)])}>
      {svg()}
    </span>
  );
}
