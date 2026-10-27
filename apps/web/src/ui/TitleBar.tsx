// The desktop window has no title bar of its own (the host's titleBar): a strip along the page's top edge drags it,
// and what is clickable in the strip stays clickable (style.css).

import { Show } from "solid-js";
import { currentHost } from "../host";

/** The strip's height, and where the window's buttons end along it; both 0 where the window has its own title bar. */
export const titleBar = currentHost().titleBar ?? { top: 0, left: 0 };

/** First in the page, so that what comes after it can take its clicks back (no-drag goes over drag in page order). */
export function WindowStrip() {
  return (
    <Show when={titleBar.top > 0}>
      <div aria-hidden="true" class="window-drag pointer-events-none fixed inset-x-0 top-0" style={{ height: `${titleBar.top}px` }} />
    </Show>
  );
}
