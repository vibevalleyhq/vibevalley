import "../infra/polyfill";
import { effect, signal } from "nsh";
import { afterEach, describe, expect, test } from "nsh/test";

import { dialogDimensions, hasOpenModal, setModalOverlayReporter, useModalOverlay, type DialogSize } from "./Dialog";

afterEach(() => {
  setModalOverlayReporter(undefined);
});

describe("design/Dialog", () => {
  test("computes pixel-capped dimensions and consistent top Y anchor on standard viewports", () => {
    const viewport = { width: 1440, height: 900 };
    expect(dialogDimensions("sm", "auto", viewport)).toEqual({ width: 480, maxHeight: 560, marginTop: 80 });
    expect(dialogDimensions("md", "auto", viewport)).toEqual({ width: 640, maxHeight: 620, marginTop: 80 });
    expect(dialogDimensions("lg", "auto", viewport)).toEqual({ width: 980, maxHeight: 765, marginTop: 80 });
    expect(dialogDimensions("xl", "auto", viewport)).toEqual({ width: 1220, maxHeight: 772, marginTop: 80 });

    expect(dialogDimensions("sm", "fixed", viewport)).toEqual({ width: 480, height: 440, marginTop: 80 });
    expect(dialogDimensions("md", "fixed", viewport)).toEqual({ width: 640, height: 540, marginTop: 80 });
    expect(dialogDimensions("lg", "fixed", viewport)).toEqual({ width: 980, height: 740, marginTop: 80 });
    expect(dialogDimensions("xl", "fixed", viewport)).toEqual({ width: 1220, height: 772, marginTop: 80 });
  });

  test("caps dimensions and top anchor on large displays instead of stretching indefinitely", () => {
    const large = { width: 2560, height: 1440 };
    const ultrawide = { width: 3840, height: 2160 };
    expect(dialogDimensions("lg", "auto", large)).toEqual({ width: 980, maxHeight: 800, marginTop: 80 });
    expect(dialogDimensions("lg", "fixed", large)).toEqual({ width: 980, height: 740, marginTop: 80 });
    expect(dialogDimensions("xl", "auto", large)).toEqual({ width: 1220, maxHeight: 900, marginTop: 80 });
    expect(dialogDimensions("xl", "fixed", large)).toEqual({ width: 1220, height: 860, marginTop: 80 });

    const sizes: readonly DialogSize[] = ["sm", "md", "lg", "xl"];
    for (const size of sizes) {
      expect(dialogDimensions(size, "auto", ultrawide)).toEqual(dialogDimensions(size, "auto", large));
      expect(dialogDimensions(size, "fixed", ultrawide)).toEqual(dialogDimensions(size, "fixed", large));
    }
  });

  test("clamps width, height, and top margin on small windows without bottom clipping", () => {
    const small = { width: 680, height: 500 };
    expect(dialogDimensions("sm", "fixed", small)).toEqual({ width: 480, height: 400, marginTop: 45 });
    expect(dialogDimensions("md", "fixed", small)).toEqual({ width: 640, height: 400, marginTop: 45 });
    expect(dialogDimensions("lg", "fixed", small)).toEqual({ width: 598, height: 425, marginTop: 45 });
    expect(dialogDimensions("xl", "fixed", small)).toEqual({ width: 612, height: 425, marginTop: 45 });
    expect(dialogDimensions("xl", "auto", small)).toEqual({ width: 612, maxHeight: 425, marginTop: 45 });

    const sizes: readonly DialogSize[] = ["sm", "md", "lg", "xl"];
    for (const size of sizes) {
      const fixed = dialogDimensions(size, "fixed", small);
      const auto = dialogDimensions(size, "auto", small);
      expect(fixed.marginTop + (fixed.height ?? 0)).toBeLessThanOrEqual(small.height);
      expect(auto.marginTop + (auto.maxHeight ?? 0)).toBeLessThanOrEqual(small.height);
    }
  });

  test("ref-counts nested modal overlays and releases on close or unmount", () => {
    const events: boolean[] = [];
    setModalOverlayReporter((active) => events.push(active));

    const firstOpen = signal(false);
    const secondOpen = signal(false);
    const firstMounted = signal(true);
    const secondMounted = signal(true);

    effect(() => {
      if (firstMounted()) useModalOverlay(() => firstOpen());
    });
    effect(() => {
      if (secondMounted()) useModalOverlay(() => secondOpen());
    });

    expect(hasOpenModal()).toBe(false);
    expect(events).toEqual([]);

    // Opening first modal raises the workbench overlay once.
    firstOpen.set(true);
    expect(hasOpenModal()).toBe(true);
    expect(events).toEqual([true]);

    // Opening a nested second modal keeps overlay active without duplicate host notification.
    secondOpen.set(true);
    expect(hasOpenModal()).toBe(true);
    expect(events).toEqual([true]);

    // Closing first while second remains open keeps overlay active.
    firstOpen.set(false);
    expect(hasOpenModal()).toBe(true);
    expect(events).toEqual([true]);

    // Unmounting the second modal while still open cleanly releases the overlay.
    secondMounted.set(false);
    expect(hasOpenModal()).toBe(false);
    expect(events).toEqual([true, false]);

    firstMounted.set(false);
    expect(hasOpenModal()).toBe(false);
    expect(events).toEqual([true, false]);
  });
});
