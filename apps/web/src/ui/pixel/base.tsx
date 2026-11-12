import type { JSX } from "@solidjs/web";
import type * as stylex from "@stylexjs/stylex";
import { Show } from "solid-js";

import { withStyles } from "#/ui/positioner.ts";

/** `border` draws a second edge inside the frame. `paperClass` is its ground as a class (`bg-cream-100`), `paper` the
 * same in StyleX. */
export function PxWindow(props: {
  children?: JSX.Element;
  paperClass?: string | undefined;
  border?: boolean;
  class?: JSX.ClassValue | undefined;
  // `paper` and `styles` are for callers still on StyleX; they go when the last of them is on classes.
  paper?: stylex.StyleXStyles<{ backgroundColor?: string }>;
  styles?: stylex.StyleXStyles;
  style?: JSX.CSSProperties | undefined;
  testid?: string;
}) {
  return (
    <div
      data-testid={props.testid}
      {...withStyles(
        [props.paper, props.styles],
        [props.paperClass ?? "bg-cream-50", "pixel-window text-bark-900", props.border === true && "border-2 border-bark-500", props.class],
        props.style,
      )}
    >
      {props.children}
    </div>
  );
}

/** The content sits 2 px in, clear of the rim. */
export function PxFrame(props: {
  children?: JSX.Element;
  paperClass?: string | undefined;
  class?: JSX.ClassValue | undefined;
  // `paper` and `styles` are for callers still on StyleX; they go when the last of them is on classes.
  paper?: stylex.StyleXStyles<{ backgroundColor?: string }>;
  styles?: stylex.StyleXStyles;
}) {
  return (
    <div {...withStyles([props.paper, props.styles], [props.paperClass ?? "bg-cream-50", "pixel-frame p-0.5 text-bark-900", props.class])}>
      {props.children}
    </div>
  );
}

export function PxCard(props: {
  title?: JSX.Element;
  aside?: JSX.Element;
  children?: JSX.Element;
  class?: JSX.ClassValue | undefined;
  // For callers still on StyleX; it goes when the last of them is on classes.
  styles?: stylex.StyleXStyles;
}) {
  return (
    <PxWindow class={["flex flex-col p-4", props.class]} styles={props.styles}>
      <Show when={props.title != null}>
        {/* The aside wraps under the title when both do not fit, instead of squeezing the title to a letter a line. */}
        <div class="mb-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
          <div class="pixel-sm">{props.title}</div>
          <Show when={props.aside != null}>
            <div class="pixel-xs text-bark-500">{props.aside}</div>
          </Show>
        </div>
      </Show>
      {props.children}
    </PxWindow>
  );
}

/** `color` is a CSS colour; dashes are twice the thickness, with gaps as long. */
export function DashedLine(props: {
  color?: string;
  thickness?: number;
  vertical?: boolean;
  class?: JSX.ClassValue | undefined;
  // For callers still on StyleX; it goes when the last of them is on classes.
  styles?: stylex.StyleXStyles;
}) {
  const thickness = () => props.thickness ?? 2;
  const color = () => props.color ?? "var(--color-cream-200)";
  return (
    <div
      aria-hidden="true"
      {...withStyles(props.styles, ["shrink-0", props.class], {
        [props.vertical === true ? "width" : "height"]: `${thickness()}px`,
        [props.vertical === true ? "height" : "width"]: "100%",
        background: `repeating-linear-gradient(${props.vertical === true ? "to bottom" : "to right"}, ${color()} 0 ${thickness() * 2}px, transparent ${thickness() * 2}px ${thickness() * 4}px)`,
      })}
    />
  );
}
