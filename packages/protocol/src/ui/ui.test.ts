import { describe, expect, test } from "vite-plus/test";

import { mixHexColor, MOTION_DURATIONS, MOTION_ENTER_CLASSES, resolveIconColorHex, TACTILE_PRESS_CLASS } from "./index";

describe("shared UI primitives (@vibevalley/protocol/ui)", () => {
  test("mixHexColor blends 6-digit and 8-digit hex tokens accurately", () => {
    expect(mixHexColor("#ff8000", 0.5)).toBe("rgba(255,128,0,0.500)");
    expect(mixHexColor("#ff800080", 0.5)).toBe("rgba(255,128,0,0.251)");
    expect(mixHexColor("transparent", 0.5)).toBe("transparent");
  });

  test("resolveIconColorHex follows color -> tone -> default semantic tone -> ink precedence", () => {
    const lookup = (name: string) => `hex:${name}`;
    expect(resolveIconColorHex({ name: "check", color: "#112233", tone: "accent" }, lookup)).toBe("#112233");
    expect(resolveIconColorHex({ name: "check", tone: "accent" }, lookup)).toBe("hex:accent");
    expect(resolveIconColorHex({ name: "check" }, lookup)).toBe("hex:leaf");
    expect(resolveIconColorHex({ name: "cross" }, lookup)).toBe("hex:berry");
    expect(resolveIconColorHex({ name: "warn" }, lookup)).toBe("hex:wheat");
    expect(resolveIconColorHex({ name: "notes" }, lookup)).toBe("hex:ink");
  });

  test("motion constants match tiered 120/180/280ms ladder", () => {
    expect(MOTION_DURATIONS).toEqual({ fast: 120, normal: 180, slow: 280 });
    expect(MOTION_ENTER_CLASSES.fast).toContain("duration-120");
    expect(TACTILE_PRESS_CLASS).toContain("duration-120");
  });
});
