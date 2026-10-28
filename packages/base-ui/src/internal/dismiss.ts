// Closing what floats over the page when the pointer goes down outside it or Escape is pressed. Layers stack: with a
// menu open inside a popover, Escape and an outside press close the menu first, then the popover.

import { createEffect } from "solid-js";

export type DismissReason = "escape" | "outside";

interface Layer {
  readonly inside: (target: Node) => boolean;
}

const layers: Layer[] = [];

/** While `open`, an outside press (not on the `elements`) or Escape on the topmost layer calls `dismiss`. */
export function createDismiss(o: { open: () => boolean; elements: () => readonly (Element | undefined)[]; dismiss: (reason: DismissReason) => void }) {
  createEffect(o.open, (on) => {
    if (!on) return;
    const layer: Layer = { inside: (target) => o.elements().some((el) => el?.contains(target)) };
    layers.push(layer);
    const top = () => layers.at(-1) === layer;
    const press = (e: PointerEvent) => {
      if (!top() || !(e.target instanceof Node) || layer.inside(e.target)) return;
      o.dismiss("outside");
    };
    const key = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !top()) return;
      e.preventDefault();
      e.stopPropagation();
      o.dismiss("escape");
    };
    document.addEventListener("pointerdown", press, true);
    document.addEventListener("keydown", key, true);
    return () => {
      document.removeEventListener("pointerdown", press, true);
      document.removeEventListener("keydown", key, true);
      layers.splice(layers.indexOf(layer), 1);
    };
  });
}
