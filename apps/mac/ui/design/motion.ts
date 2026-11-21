// 0 rather than no transition, so end states still apply.
import { reduceMotion } from "nsh";

const ease = "cubic-bezier(0.2, 0, 0, 1)";

const durations = {
  press: 160,
} as const;

export function ms(d: number): number {
  return reduceMotion() ? 0 : d;
}

export function pressTransition() {
  return {
    transitionProperty: "colors,opacity,transform",
    transitionDuration: ms(durations.press),
    transitionTimingFunction: ease,
  } as const;
}
