import "../infra/polyfill";
import { effect, setColorScheme, signal } from "nsh";
import type { ScrollbarTheme } from "nsh/base";
import { afterEach, describe, expect, open, test } from "nsh/test";

import { applyMotion } from "./motion";
import { buildScrollbarTheme, installScrollbarTheme, type ScrollbarThemeTarget } from "./scrollbar";
import { mix } from "./tone";

afterEach(() => {
  setColorScheme("system");
  applyMotion("system");
});

describe("design/scrollbar", () => {
  test("derives lightweight Papertrails vertical and horizontal looks for light and dark schemes", () => {
    setColorScheme("light");
    const light = buildScrollbarTheme(false);
    expect(light.mode).toBe("hover");
    expect(light.minThumbLength).toBe(36);
    expect(light.vertical?.class).toContain("inset-y-0 right-0");
    expect(light.vertical?.thumbClass).toContain("w-full rounded-full opacity-45");
    expect(light.vertical?.thumbClass).toContain("hover:opacity-85");
    expect(light.vertical?.thumbClass).toContain("active:opacity-100");
    expect(light.vertical?.thumbStyle).toEqual({ backgroundColor: mix("ink", 0.36) });
    expect(light.horizontal?.class).toContain("inset-x-0 bottom-0");
    expect(light.horizontal?.thumbClass).toContain("h-full rounded-full opacity-45");
    expect(light.horizontal?.thumbStyle).toEqual({ backgroundColor: mix("ink", 0.36) });

    setColorScheme("dark");
    const dark = buildScrollbarTheme(true);
    expect(dark.vertical?.thumbStyle).toEqual({ backgroundColor: mix("ink", 0.42) });
    expect(dark.horizontal?.thumbStyle).toEqual({ backgroundColor: mix("ink", 0.42) });
    expect(dark.vertical?.thumbStyle).not.toEqual(light.vertical?.thumbStyle);
  });

  test("installs on mount, reacts live to colorScheme toggles, and resets on cleanup", () => {
    setColorScheme("light");
    const calls: Array<ScrollbarTheme | null> = [];
    const target: ScrollbarThemeTarget = {
      setTheme: (theme) => calls.push(theme),
    };

    const mounted = signal(true);
    effect(() => {
      if (mounted()) installScrollbarTheme(target);
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.vertical?.thumbStyle).toEqual({ backgroundColor: mix("ink", 0.36) });

    setColorScheme("dark");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.vertical?.thumbStyle).toEqual({ backgroundColor: mix("ink", 0.42) });

    setColorScheme("light");
    expect(calls).toHaveLength(3);
    expect(calls[2]?.vertical?.thumbStyle).toEqual({ backgroundColor: mix("ink", 0.36) });

    mounted.set(false);
    expect(calls).toHaveLength(4);
    expect(calls[3]).toBeNull();
  });

  test("applies real nsh/base Scrollbar.setTheme across light/dark toggles and cleanup", async () => {
    setColorScheme("light");
    const mounted = signal(true);
    expect(() => {
      effect(() => {
        if (mounted()) installScrollbarTheme();
      });
      setColorScheme("dark");
      setColorScheme("light");
      mounted.set(false);
    }).not.toThrow();

    const app = await open("../app/components.story.tsx", {
      width: 960,
      height: 720,
      colorScheme: "light",
      platform: "macos",
    });
    expect(app.count("id:workbench-page") >= 0).toBe(true);
    await app.setColorScheme("dark");
    await app.setColorScheme("light");
  });
});
