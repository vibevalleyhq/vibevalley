import type { JSX } from "@solidjs/web";
import * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { styleProps } from "#/ui/positioner.ts";

import { pxStyle } from "./style";

const viewStyles = stylex.create({
  paper: { backgroundColor: "var(--color-cream-50)" },
  ink: { color: "var(--color-bark-900)" },
  border: { borderWidth: 2, borderStyle: "solid", borderColor: "var(--color-bark-500)" },
  rim: { padding: "0.125rem" },
  card: { display: "flex", flexDirection: "column", padding: "1rem" },
  dash: { flexShrink: 0 },
  pxCardHeader: {
    marginBottom: "0.75rem",
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    justifyContent: "space-between",
    columnGap: "0.5rem",
    rowGap: "0.25rem",
  },
  pxCardAside: {
    color: "var(--color-bark-500)",
  },
});

/** `border` draws a second edge inside the frame. */
export function PxWindow(props: {
  children?: JSX.Element;
  paper?: stylex.StyleXStyles<{ backgroundColor?: string }>;
  border?: boolean;
  styles?: stylex.StyleXStyles;
  style?: JSX.CSSProperties | undefined;
  testid?: string;
}) {
  return (
    <div
      data-testid={props.testid}
      {...styleProps([viewStyles.paper, props.paper, pxStyle.window, props.border === true && viewStyles.border, viewStyles.ink, props.styles], props.style)}
    >
      {props.children}
    </div>
  );
}

/** The content sits 2 px in, clear of the rim. */
export function PxFrame(props: { children?: JSX.Element; paper?: stylex.StyleXStyles<{ backgroundColor?: string }>; styles?: stylex.StyleXStyles }) {
  return <div {...styleProps([viewStyles.paper, props.paper, pxStyle.frame, viewStyles.rim, viewStyles.ink, props.styles])}>{props.children}</div>;
}

export function PxCard(props: { title?: JSX.Element; aside?: JSX.Element; children?: JSX.Element; styles?: stylex.StyleXStyles }) {
  return (
    <PxWindow styles={[viewStyles.card, props.styles]}>
      <Show when={props.title != null}>
        {/* The aside wraps under the title when both do not fit, instead of squeezing the title to a letter a line. */}
        <div {...stylex.attrs(viewStyles.pxCardHeader)}>
          <div {...stylex.attrs(pxStyle.sm)}>{props.title}</div>
          <Show when={props.aside != null}>
            <div {...stylex.attrs(pxStyle.xs, viewStyles.pxCardAside)}>{props.aside}</div>
          </Show>
        </div>
      </Show>
      {props.children}
    </PxWindow>
  );
}

/** `color` is a CSS colour; dashes are twice the thickness, with gaps as long. */
export function DashedLine(props: { color?: string; thickness?: number; vertical?: boolean; styles?: stylex.StyleXStyles }) {
  const thickness = () => props.thickness ?? 2;
  const color = () => props.color ?? "var(--color-cream-200)";
  return (
    <div
      aria-hidden="true"
      {...styleProps([viewStyles.dash, props.styles], {
        [props.vertical === true ? "width" : "height"]: `${thickness()}px`,
        [props.vertical === true ? "height" : "width"]: "100%",
        background: `repeating-linear-gradient(${props.vertical === true ? "to bottom" : "to right"}, ${color()} 0 ${thickness() * 2}px, transparent ${thickness() * 2}px ${thickness() * 4}px)`,
      })}
    />
  );
}
