// A floating part kept against its anchor (the trigger) with @floating-ui/dom: placed on a side and aligned, turned to the
// other side and pushed back in when the window edge is near, and moved along while either scrolls or resizes.

import { autoUpdate, computePosition, flip, offset, type Placement, shift } from "@floating-ui/dom";
import { createEffect, createSignal } from "solid-js";

export type Side = "top" | "bottom" | "left" | "right";
export type Align = "start" | "center" | "end";

export interface AnchorOptions {
  side?: Side | undefined;
  align?: Align | undefined;
  /** Gap between the anchor and the popup, px. */
  sideOffset?: number | undefined;
  /** Distance kept from the window's edges, px. */
  collisionPadding?: number | undefined;
}

const placementOf = (side: Side, align: Align): Placement => (align === "center" ? side : `${side}-${align}`);

/** Where the floating element is, and on which side and alignment it ended up, while both elements exist. */
export function createAnchored(anchor: () => Element | undefined, floating: () => HTMLElement | undefined, o: () => AnchorOptions) {
  const [at, setAt] = createSignal({ x: 0, y: 0, side: o().side ?? "bottom", align: o().align ?? "center", placed: false, anchorWidth: 0 });
  createEffect(
    () => [anchor(), floating()] as const,
    ([a, f]) => {
      if (!a || !f) return;
      const place = () => {
        const { side = "bottom", align = "center", sideOffset = 4, collisionPadding = 8 } = o();
        void computePosition(a, f, {
          strategy: "fixed",
          placement: placementOf(side, align),
          middleware: [offset(sideOffset), flip({ padding: collisionPadding }), shift({ padding: collisionPadding })],
        }).then((p) => {
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- floating-ui's Placement is a Side, or a Side and start or end
          const [s, al = "center"] = p.placement.split("-") as [Side, Align?];
          setAt({ x: p.x, y: p.y, side: s, align: al, placed: true, anchorWidth: a.getBoundingClientRect().width });
        });
      };
      return autoUpdate(a, f, place);
    },
  );
  return at;
}
