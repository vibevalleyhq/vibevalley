import "../infra/polyfill";
import { describe, expect, test } from "nsh/test";

import { dialogDimensions, type DialogSize } from "./Dialog";

describe("design/Dialog", () => {
  test("computes pixel-capped dimensions and consistent top Y anchor on standard viewports", () => {
    const viewport = { width: 1440, height: 900 };
    expect(dialogDimensions("sm", "auto", viewport)).toEqual({ width: 480, maxHeight: 560, marginTop: 80 });
    expect(dialogDimensions("md", "auto", viewport)).toEqual({ width: 640, maxHeight: 620, marginTop: 80 });
    expect(dialogDimensions("lg", "auto", viewport)).toEqual({ width: 820, maxHeight: 680, marginTop: 80 });
    expect(dialogDimensions("xl", "auto", viewport)).toEqual({ width: 1000, maxHeight: 720, marginTop: 80 });

    expect(dialogDimensions("sm", "fixed", viewport)).toEqual({ width: 480, height: 440, marginTop: 80 });
    expect(dialogDimensions("md", "fixed", viewport)).toEqual({ width: 640, height: 540, marginTop: 80 });
    expect(dialogDimensions("lg", "fixed", viewport)).toEqual({ width: 820, height: 640, marginTop: 80 });
    expect(dialogDimensions("xl", "fixed", viewport)).toEqual({ width: 1000, height: 680, marginTop: 80 });
  });

  test("caps dimensions and top anchor on large displays instead of stretching indefinitely", () => {
    const large = { width: 2560, height: 1440 };
    const sizes: readonly DialogSize[] = ["sm", "md", "lg", "xl"];
    for (const size of sizes) {
      expect(dialogDimensions(size, "auto", large)).toEqual(dialogDimensions(size, "auto", { width: 1440, height: 900 }));
      expect(dialogDimensions(size, "fixed", large)).toEqual(dialogDimensions(size, "fixed", { width: 1440, height: 900 }));
    }
  });

  test("clamps width, height, and top margin on small windows without bottom clipping", () => {
    const small = { width: 680, height: 500 };
    expect(dialogDimensions("sm", "fixed", small)).toEqual({ width: 480, height: 400, marginTop: 45 });
    expect(dialogDimensions("md", "fixed", small)).toEqual({ width: 640, height: 400, marginTop: 45 });
    expect(dialogDimensions("lg", "fixed", small)).toEqual({ width: 648, height: 410, marginTop: 45 });
    expect(dialogDimensions("xl", "fixed", small)).toEqual({ width: 632, height: 410, marginTop: 45 });
    expect(dialogDimensions("xl", "auto", small)).toEqual({ width: 632, maxHeight: 410, marginTop: 45 });

    const sizes: readonly DialogSize[] = ["sm", "md", "lg", "xl"];
    for (const size of sizes) {
      const fixed = dialogDimensions(size, "fixed", small);
      const auto = dialogDimensions(size, "auto", small);
      expect(fixed.marginTop + (fixed.height ?? 0)).toBeLessThanOrEqual(small.height);
      expect(auto.marginTop + (auto.maxHeight ?? 0)).toBeLessThanOrEqual(small.height);
    }
  });
});
