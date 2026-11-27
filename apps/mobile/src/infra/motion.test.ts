import { reduceMotion } from "nsh";
import { expect, test } from "nsh/test";

import { applyMotion, fadeAnimation, MOTION_DURATION, motionChoice, motionClass, motionDuration, motionEnter, motionOff, popupTransition } from "./motion";

test("mobile motion gate exposes tiered durations and respects choice overrides", () => {
  expect(MOTION_DURATION).toEqual({ fast: 120, normal: 180, slow: 280 });
  expect(motionChoice()).toBe("system");
  expect(motionOff()).toBe(reduceMotion());

  applyMotion("on");
  expect(motionChoice()).toBe("on");
  expect(motionOff()).toBe(false);
  expect(motionClass("transition-transform duration-120 ease-out active:translate-y-px")).toBe(
    "transition-transform duration-120 ease-out active:translate-y-px",
  );
  expect(motionEnter("fast")).toBe("transition-transform duration-120 ease-out");
  expect(motionEnter("normal")).toBe("transition-opacity duration-180 ease-out");
  expect(motionEnter("slow")).toBe("transition-opacity duration-280 ease-out");
  expect(motionDuration(MOTION_DURATION.fast)).toBe(120);
  expect(motionDuration(MOTION_DURATION.normal)).toBe(180);
  expect(motionDuration(MOTION_DURATION.slow)).toBe(280);
  expect(fadeAnimation()).toBe("fade");
  expect(popupTransition("opacity-0")).toBe("opacity-0");

  applyMotion("off");
  expect(motionOff()).toBe(true);
  expect(motionClass("transition-transform duration-120 ease-out")).toBe("");
  expect(motionEnter("normal")).toBe("");
  expect(motionDuration(MOTION_DURATION.normal)).toBe(0);
  expect(fadeAnimation()).toBe("none");
  expect(popupTransition("opacity-0")).toBeUndefined();

  applyMotion("invalid");
  expect(motionChoice()).toBe("off");
  applyMotion("system");
  expect(motionChoice()).toBe("system");
  expect(motionOff()).toBe(reduceMotion());
});

test("mobile motion gate honors deterministic off-switch (__VIBEVALLEY_NO_ANIMATION__)", () => {
  applyMotion("on");
  const prevGlobal: unknown = Reflect.get(globalThis, "__VIBEVALLEY_NO_ANIMATION__");
  try {
    Reflect.set(globalThis, "__VIBEVALLEY_NO_ANIMATION__", true);
    expect(motionOff()).toBe(true);
    expect(motionClass("transition-transform duration-120 ease-out")).toBe("");
    expect(motionEnter("slow")).toBe("");
    expect(motionDuration(MOTION_DURATION.slow)).toBe(0);
    expect(fadeAnimation()).toBe("none");
    expect(popupTransition("opacity-0")).toBeUndefined();
  } finally {
    if (prevGlobal === undefined) Reflect.deleteProperty(globalThis, "__VIBEVALLEY_NO_ANIMATION__");
    else Reflect.set(globalThis, "__VIBEVALLEY_NO_ANIMATION__", prevGlobal);
    applyMotion("system");
  }
});
