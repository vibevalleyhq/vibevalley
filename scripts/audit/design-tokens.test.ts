import { describe, expect, it } from "vite-plus/test";

import { hexColor, offTokens } from "./design-tokens.ts";

describe("the workbench's StyleX design ladders", () => {
  it.each([
    ["borderRadius", "var(--radius-md)"],
    ["borderTopLeftRadius", 0],
    ["borderRadius", "var(--radius-sm) 0"],
    ["borderRadius", "calc(infinity * 1px)"],
    ["borderRadius", "2147483647px"],
    ["fontSize", "var(--text-2xs)"],
    ["fontSize", "var(--text-2xl)"],
    ["fontSize", "var(--text-3xl)"],
    ["fontSize", "inherit"],
    ["transitionDuration", "120ms, 0.18s, 280ms"],
    ["transitionDuration", "var(--default-transition-duration)"],
    ["transitionTimingFunction", "var(--ease-out)"],
    ["transitionTimingFunction", "var(--default-transition-timing-function)"],
    ["transition", "none"],
    ["zIndex", -10],
    ["zIndex", "auto"],
    ["boxShadow", "var(--shadow-float)"],
    ["boxShadow", "inset 0 2px 0 var(--color-accent)"],
    ["boxShadow", "0 0 0 1px currentColor"],
    ["boxShadow", "none"],
  ])("accepts %s: %s", (property, value) => {
    expect(offTokens(property, value)).toBeUndefined();
  });

  it.each([
    ["borderRadius", "7px", "radius"],
    ["borderEndStartRadius", 4, "radius"],
    ["borderRadius", "var(--made-up-radius)", "radius"],
    ["fontSize", "11px", "type"],
    ["fontSize", "var(--text-7xl)", "type"],
    ["transitionDuration", "150ms", "motion"],
    ["transitionDuration", "var(--duration-whatever)", "motion"],
    ["transitionDuration", "120ms, 2s", "motion"],
    ["transitionTimingFunction", "cubic-bezier(0,0,1,1)", "motion"],
    ["transition", "color 150ms ease", "motion"],
    ["zIndex", 999, "layer"],
    ["zIndex", -50, "layer"],
    ["boxShadow", "0 1px 2px black", "shadow"],
    ["boxShadow", "var(--arbitrary)", "shadow"],
  ])("rejects %s: %s as %s", (property, value, kind) => {
    expect(offTokens(property, value)).toBe(kind);
  });

  it("checks disabled opacity only in that state", () => {
    expect(offTokens("opacity", 0.4)).toBeUndefined();
    expect(offTokens("opacity", 0.5, true)).toBeUndefined();
    expect(offTokens("opacity", 0.4, true)).toBe("disabled");
  });

  it("leaves scene geometry and living-state animation periods alone", () => {
    for (const property of ["width", "height", "top", "left", "translate", "gap", "animationDuration"]) {
      expect(offTokens(property, "37px")).toBeUndefined();
    }
  });

  it("finds hex paint, including gradients and shadows, but not URL fragments or content", () => {
    expect(hexColor("color", "#e3efd2")).toBe(true);
    expect(hexColor("boxShadow", "0 1px 2px #2f1f1326")).toBe(true);
    expect(hexColor("backgroundImage", "linear-gradient(#abc, var(--color-page))")).toBe(true);
    expect(hexColor(undefined, "#abcd")).toBe(true);
    expect(hexColor("color", "var(--color-ink)")).toBe(false);
    expect(hexColor("backgroundImage", "url('/art.svg#abc')")).toBe(false);
    expect(hexColor("content", "'#abc'")).toBe(false);
    expect(hexColor("color", "#abcde")).toBe(false);
  });
});
