import { createMemo } from "solid-js";
import { renderSVG } from "uqr";

/** A QR code of text, black on white with its quiet zone. The svg is parsed into a node, without innerHTML. */
export function Qr(props: { text: string; size?: number; label: string }) {
  const svg = createMemo(() => new DOMParser().parseFromString(renderSVG(props.text, { border: 2 }), "image/svg+xml").documentElement);
  return (
    <span
      role="img"
      aria-label={props.label}
      class="block bg-white [&>svg]:h-full [&>svg]:w-full"
      style={{ width: `${props.size ?? 208}px`, height: `${props.size ?? 208}px` }}
    >
      {svg()}
    </span>
  );
}
