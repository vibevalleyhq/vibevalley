import type { JSX } from "@solidjs/web";
import { Show } from "solid-js";

/** `border` draws a second edge inside the frame. `paperClass` is its ground as a class (`bg-cream-100`). */
export function PxWindow(props: {
  children?: JSX.Element;
  paperClass?: string | undefined;
  border?: boolean;
  class?: JSX.ClassValue | undefined;
  style?: JSX.CSSProperties | undefined;
  testid?: string;
}) {
  return (
    <div
      data-testid={props.testid}
      class={[props.paperClass ?? "bg-cream-50", "pixel-window text-bark-900", props.border === true && "border-2 border-bark-500", props.class]}
      style={props.style}
    >
      {props.children}
    </div>
  );
}

/** The content sits 2 px in, clear of the rim. */
export function PxFrame(props: { children?: JSX.Element; paperClass?: string | undefined; class?: JSX.ClassValue | undefined }) {
  return <div class={[props.paperClass ?? "bg-cream-50", "pixel-frame p-0.5 text-bark-900", props.class]}>{props.children}</div>;
}

export function PxCard(props: { title?: JSX.Element; aside?: JSX.Element; children?: JSX.Element; class?: JSX.ClassValue | undefined }) {
  return (
    <PxWindow class={["flex flex-col p-4", props.class]}>
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
export function DashedLine(props: { color?: string; thickness?: number; vertical?: boolean; class?: JSX.ClassValue | undefined }) {
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
