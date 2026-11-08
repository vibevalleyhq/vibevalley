import { animate, type AnimationOptions, type DOMKeyframesDefinition } from "motion";
import { createEffect, onSettled } from "solid-js";

import { reducedMotion, type ElementSource } from "./scroll";

export function createEntrance(ref: ElementSource, source: () => unknown, keyframes: DOMKeyframesDefinition, options: AnimationOptions) {
  onSettled(() => {
    createEffect(source, () => {
      const element = ref.get();
      if (!element) return;
      const frames = reducedMotion() ? { opacity: keyframes.opacity ?? 1 } : keyframes;
      const animation = animate(element, frames, options);
      return () => animation.stop();
    });
  });
}
