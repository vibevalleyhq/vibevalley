// Under reduced motion `ms` is 0, so end states still apply.
import { LayoutAnimation, reduceMotion } from "nsh";

export const ease = "cubic-bezier(0.2, 0, 0, 1)";

export const durations = {
  press: 160,
  statusSwap: 360,
  expandHeight: 400,
  expandOpacity: 240,
  chevron: 360,
  foldHold: 1100,
  foldHeight: 460,
  foldOpacity: 300,
  spinner: 800,
  copyConfirm: 1400,
  timerTick: 100,
} as const;

export function ms(d: number): number {
  return reduceMotion() ? 0 : d;
}

/** Style fragment for color/opacity transitions on hover and press. */
export function pressTransition() {
  return {
    transitionProperty: "colors,opacity,transform",
    transitionDuration: ms(durations.press),
    transitionTimingFunction: ease,
  } as const;
}

/** Elapsed time as the live timer shows it: tenths below a minute. */
export function formatElapsed(msElapsed: number): string {
  if (msElapsed < 60_000) return `${(msElapsed / 1000).toFixed(1)}s`;
  const s = Math.floor(msElapsed / 1000);
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Animates the size changes of the next commit (expand, collapse, fold). */
export function animateLayout(duration: number = durations.expandHeight): void {
  if (reduceMotion()) return;
  LayoutAnimation.configureNext(LayoutAnimation.create(duration));
}
