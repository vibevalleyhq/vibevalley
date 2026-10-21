import type { JSX } from "@solidjs/web";

// The pixel icons (apps/web/public/pixel, served at /pixel): drawn whole-pixel, never smoothed.

export function Icon(props: { name: string; size?: number; label?: string; class?: JSX.ClassValue }) {
  return (
    <img
      src={`/pixel/${props.name}.png`}
      width={props.size ?? 16}
      height={props.size ?? 16}
      alt={props.label ?? ""}
      aria-hidden={props.label ? undefined : "true"}
      draggable="false"
      class={["shrink-0 object-contain [image-rendering:pixelated]", props.class]}
    />
  );
}
