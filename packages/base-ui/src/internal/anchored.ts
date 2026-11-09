import { autoUpdate, computePosition, flip, offset, type Placement, shift } from "@floating-ui/dom";
import { createEffect, createSignal, untrack } from "solid-js";

export type Side = "top" | "bottom" | "left" | "right";
export type Align = "start" | "center" | "end";

interface AnchorOptions {
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
  const [at, setAt] = createSignal(
    untrack(() => {
      const { side = "bottom", align = "center" } = o();
      return { x: 0, y: 0, side, align, placed: false, anchorWidth: 0 };
    }),
  );
  createEffect(
    () => {
      const { side = "bottom", align = "center", sideOffset = 4, collisionPadding = 8 } = o();
      return { a: anchor(), f: floating(), side, align, sideOffset, collisionPadding };
    },
    ({ a, f, side, align, sideOffset, collisionPadding }) => {
      if (!a || !f) return;
      const placement = placementOf(side, align);
      const middleware = [offset(sideOffset), flip({ padding: collisionPadding }), shift({ padding: collisionPadding })];
      let active = true;
      let request = 0;
      const place = () => {
        const current = ++request;
        void computePosition(a, f, {
          strategy: "fixed",
          placement,
          middleware,
        }).then((p) => {
          if (!active || current !== request) return;
          // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- floating-ui's Placement is a Side, or a Side and start or end
          const [s, al = "center"] = p.placement.split("-") as [Side, Align?];
          const anchorWidth = a.getBoundingClientRect().width;
          setAt((prev) =>
            prev.placed && prev.x === p.x && prev.y === p.y && prev.side === s && prev.align === al && prev.anchorWidth === anchorWidth
              ? prev
              : { x: p.x, y: p.y, side: s, align: al, placed: true, anchorWidth },
          );
        });
      };
      const cleanup = autoUpdate(a, f, place);
      return () => {
        active = false;
        cleanup();
      };
    },
  );
  return at;
}
