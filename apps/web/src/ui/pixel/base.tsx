import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { pxText, pxWindow } from "./style";

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

export function PxCard(props: { title?: JSX.Element; aside?: JSX.Element; children?: JSX.Element; class?: string }) {
  return (
    <PxWindow class={["flex flex-col p-4", props.class]}>
      <Show when={props.title != null}>
        {/* The aside wraps under the title when both do not fit, instead of squeezing the title to a letter a line. */}
        <div class="mb-3 flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
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
