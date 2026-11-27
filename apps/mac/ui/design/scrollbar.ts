import { cleanup, colorScheme, effect } from "nsh";
import { Scrollbar, type ScrollbarLook, type ScrollbarTheme } from "nsh/base";

import { motionClass, motionDuration } from "./motion";
import { mix } from "./tone";

export interface ScrollbarThemeTarget {
  setTheme(theme: ScrollbarTheme | null): void;
}

const TRACK_CLASS = {
  vertical: "absolute inset-y-0 right-0 w-2.5 px-0.5 py-1",
  horizontal: "absolute inset-x-0 bottom-0 h-2.5 px-1 py-0.5",
} as const;

const THUMB_STATE_CLASSES = "rounded-full opacity-45 group-hover:opacity-75 hover:opacity-85 active:opacity-100";

function buildThumbClass(axis: "vertical" | "horizontal"): string {
  const sizeClass = axis === "vertical" ? "w-full" : "h-full";
  const motion = motionClass("transition-opacity duration-120 ease-out");
  return motion ? `${sizeClass} ${THUMB_STATE_CLASSES} ${motion}` : `${sizeClass} ${THUMB_STATE_CLASSES}`;
}

function buildLook(axis: "vertical" | "horizontal", thumbColor: string): ScrollbarLook {
  return {
    class: TRACK_CLASS[axis],
    thumbClass: buildThumbClass(axis),
    thumbStyle: { backgroundColor: thumbColor },
  };
}

/** Builds the Papertrails scrollbar theme from the active light or dark semantic tokens. */
export function buildScrollbarTheme(dark = colorScheme() === "dark"): ScrollbarTheme {
  // Subtle warm ink at low resting opacity (via thumbClass opacity-45..100) replaces GPUI's harsh dark fill + white rim.
  const thumbColor = mix("ink", dark ? 0.42 : 0.36);
  return {
    mode: "hover",
    minThumbLength: 36,
    motion: {
      idle: 1000,
      enter: motionDuration(120),
      exit: motionDuration(240),
      entrance: "fade",
      thumbHoverEntrance: "fade",
    },
    vertical: buildLook("vertical", thumbColor),
    horizontal: buildLook("horizontal", thumbColor),
  };
}

/** Applies the Papertrails scrollbar theme reactively and restores platform indicators on cleanup. */
export function installScrollbarTheme(target: ScrollbarThemeTarget = Scrollbar): void {
  effect(() => {
    const dark = colorScheme() === "dark";
    target.setTheme(buildScrollbarTheme(dark));
  });
  cleanup(() => {
    target.setTheme(null);
  });
}
