import { createMemo } from "solid-js";
import { renderSVG } from "uqr";

/** A QR code of text, black on white with its quiet zone. The svg is parsed into a node, without innerHTML. */
export function Qr(props: { text: string; size?: number; label: string }) {
  const svg = createMemo(() => {
    const node = new DOMParser().parseFromString(renderSVG(props.text, { border: 2 }), "image/svg+xml").documentElement;
    node.setAttribute("class", "size-full");
    return node;
  });
  const size = () => `${props.size ?? 208}px`;
  return (
    <span role="img" aria-label={props.label} class="block bg-white" style={{ width: size(), height: size() }}>
      {svg()}
    </span>
  );
}
