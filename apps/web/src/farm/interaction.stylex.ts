import * as stylex from "@stylexjs/stylex";

export const farmGroup = stylex.defineMarker();
export const farmMessage = stylex.defineMarker();

const shake = stylex.keyframes({
  "0%, 24.99%": { transform: "translate(-1px, 0)" },
  "25%, 49.99%": { transform: "translate(1px, 0)" },
  "50%, 74.99%": { transform: "translate(-1px, -1px)" },
  "75%, 100%": { transform: "translate(1px, 0)" },
});
const blink = stylex.keyframes({
  "0%, 49.99%": { opacity: 1 },
  "50%, 100%": { opacity: 0.3 },
});
export const phoneAnimations = stylex.create({
  shake: {
    animationName: { default: shake, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "500ms",
    animationIterationCount: "infinite",
  },
  blink: {
    animationName: { default: blink, "@media (prefers-reduced-motion: reduce)": "none" },
    animationDuration: "1s",
    animationIterationCount: "infinite",
  },
});
