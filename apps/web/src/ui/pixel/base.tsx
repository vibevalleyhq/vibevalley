import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { pxFrame, pxText, pxWindow } from "./style";

const viewStyles = stylex.create({
  pxCardDiv: {
    marginBottom: "calc(var(--spacing) * 3)",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: "calc(var(--spacing) * 2)",
    rowGap: "var(--spacing)",
  },
});

/** `border` draws a second edge inside the frame. `paper` is a bg-* class. */
export function PxWindow(props: {
  children?: JSX.Element;
  paper?: string;
  border?: boolean;
  class?: JSX.ClassValue;
  style?: JSX.CSSProperties | undefined;
  testid?: string;
}) {
  return (
    <div
      data-testid={props.testid}
      class={[props.paper ?? "bg-cream-50", pxWindow, { "border-2 border-bark-500": !(props.border !== true) }, "text-bark-900", props.class]}
      style={props.style}
    >
      {props.children}
    </div>
  );
}

/** `paper` is a bg-* class; the content sits 2 px in, clear of the rim. */
export function PxFrame(props: { children?: JSX.Element; paper?: string; class?: string }) {
  return <div class={[props.paper ?? "bg-cream-50", pxFrame, "p-0.5 text-bark-900", props.class]}>{props.children}</div>;
}

export function PxCard(props: { title?: JSX.Element; aside?: JSX.Element; children?: JSX.Element; class?: string }) {
  return (
    <PxWindow class={["flex flex-col p-4", props.class]}>
      <Show when={props.title != null}>
        {/* The aside wraps under the title when both do not fit, instead of squeezing the title to a letter a line. */}
        <div {...stylex.attrs(viewStyles.pxCardDiv)}>
          <div class={pxText.sm}>{props.title}</div>
          <Show when={props.aside != null}>
            <div class={[pxText.xs, "text-bark-500"]}>{props.aside}</div>
          </Show>
        </div>
      </Show>
      {props.children}
    </PxWindow>
  );
}

/** `color` is a CSS colour; dashes are twice the thickness, with gaps as long. */
export function DashedLine(props: { color?: string; thickness?: number; vertical?: boolean; class?: string }) {
  const thickness = () => props.thickness ?? 2;
  const color = () => props.color ?? "var(--color-cream-200)";
  return (
    <div
      aria-hidden="true"
      class={["shrink-0", props.class]}
      style={{
        [props.vertical === true ? "width" : "height"]: `${thickness()}px`,
        [props.vertical === true ? "height" : "width"]: "100%",
        background: `repeating-linear-gradient(${props.vertical === true ? "to bottom" : "to right"}, ${color()} 0 ${thickness() * 2}px, transparent ${thickness() * 2}px ${thickness() * 4}px)`,
      }}
    />
  );
}
