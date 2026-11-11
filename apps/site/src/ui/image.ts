import { animate } from "motion";

import { reducedMotion } from "./scroll";

export function createImageTransition(image: HTMLImageElement, source: HTMLImageElement, exiting = false) {
  if (reducedMotion()) return () => {};
  const from = source.getBoundingClientRect();
  const to = image.getBoundingClientRect();
  if (to.width === 0 || to.height === 0) return () => {};
  const x = from.left - to.left;
  const y = from.top - to.top;
  const scaleX = from.width / to.width;
  const scaleY = from.height / to.height;
  image.style.transformOrigin = "0 0";
  const animation = animate(
    image,
    {
      x: exiting ? [0, x] : [x, 0],
      y: exiting ? [0, y] : [y, 0],
      scaleX: exiting ? [1, scaleX] : [scaleX, 1],
      scaleY: exiting ? [1, scaleY] : [scaleY, 1],
    },
    { duration: 0.3, ease: [0.4, 0, 0.2, 1] },
  );
  return () => animation.stop();
}
