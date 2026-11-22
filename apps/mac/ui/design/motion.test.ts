import "../infra/polyfill";
import { effect, reduceMotion } from "nsh";
import { afterEach, describe, expect, test } from "nsh/test";

import { applyMotion, chooseMotion, fadeAnimation, motionChoice, motionClass, motionDuration, motionOff, popupTransition } from "./motion";

afterEach(() => {
  applyMotion("system");
});

describe("design/motion", () => {
  test("defaults to system and resolves helpers across off, on, and system", () => {
    expect(motionChoice()).toBe("system");
    const systemOff = reduceMotion();
    expect(motionOff()).toBe(systemOff);
    expect(motionClass("transition-transform duration-120 ease-out")).toBe(systemOff ? "" : "transition-transform duration-120 ease-out");
    expect(motionDuration(120)).toBe(systemOff ? 0 : 120);
    expect(fadeAnimation()).toBe(systemOff ? "none" : "fade");
    expect(popupTransition("opacity-0")).toBe(systemOff ? undefined : "opacity-0");

    applyMotion("off");
    expect(motionChoice()).toBe("off");
    expect(motionOff()).toBe(true);
    expect(motionClass("transition-transform duration-120 ease-out")).toBe("");
    expect(motionClass("animate-pulse")).toBe("");
    expect(motionDuration(120)).toBe(0);
    expect(motionDuration(180)).toBe(0);
    expect(fadeAnimation()).toBe("none");
    expect(popupTransition("opacity-0")).toBeUndefined();

    applyMotion("on");
    expect(motionChoice()).toBe("on");
    expect(motionOff()).toBe(false);
    expect(motionClass("transition-opacity duration-120 ease-out")).toBe("transition-opacity duration-120 ease-out");
    expect(motionClass("animate-pulse")).toBe("animate-pulse");
    expect(motionDuration(180)).toBe(180);
    expect(fadeAnimation()).toBe("fade");
    expect(popupTransition("opacity-0")).toBe("opacity-0");

    applyMotion("system");
    expect(motionChoice()).toBe("system");
    expect(motionOff()).toBe(systemOff);
  });

  test("ignores invalid values in applyMotion and updates reactively via chooseMotion", () => {
    applyMotion("off");
    applyMotion("invalid");
    applyMotion("");
    applyMotion(null);
    applyMotion(undefined);
    applyMotion(42);
    expect(motionChoice()).toBe("off");

    const observed: Array<{ off: boolean; fade: "fade" | "none"; duration: number }> = [];
    let tracking = true;
    effect(() => {
      const snapshot = { off: motionOff(), fade: fadeAnimation(), duration: motionDuration(180) };
      if (tracking) observed.push(snapshot);
    });

    chooseMotion("on");
    chooseMotion("off");
    chooseMotion("system");
    tracking = false;

    expect(observed).toEqual([
      { off: true, fade: "none", duration: 0 },
      { off: false, fade: "fade", duration: 180 },
      { off: true, fade: "none", duration: 0 },
      { off: reduceMotion(), fade: reduceMotion() ? "none" : "fade", duration: reduceMotion() ? 0 : 180 },
    ]);
  });
});
