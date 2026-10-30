import type { JSX } from "@solidjs/web";

import { pxFrame } from "./style";

/** `paper` is a bg-* class; the content sits 2 px in, clear of the rim. */
export function PxFrame(props: { children?: JSX.Element; paper?: string; class?: string }) {
  return <div class={[props.paper ?? "bg-cream-50", pxFrame, "p-0.5 text-bark-900", props.class]}>{props.children}</div>;
}
