import { describe, expect, it } from "vite-plus/test";

import { assertInlineLayoutStable, diffLayoutDumps, flattenLayoutDump, type VdpLayoutDump } from "./layout.ts";

function makeDump(overrides?: { readonly lineCount?: number; readonly p2Y?: number; readonly siblingY?: number }): VdpLayoutDump {
  return {
    viewport: { x: 0, y: 0, width: 1440, height: 900 },
    scaleFactor: 2,
    themeDark: false,
    route: "/notes/n1",
    surfaces: [
      {
        id: "view:workbench",
        role: "root",
        surface: "workbench",
        bounds: { x: 0, y: 0, width: 1440, height: 900 },
        pressable: false,
        children: [
          {
            id: "doc-block-p2",
            role: "group",
            bounds: { x: 320, y: overrides?.p2Y ?? 180, width: 680, height: 28 },
            pressable: false,
            children: [
              {
                id: "doc-block-input-p2",
                role: "textbox",
                bounds: { x: 320, y: overrides?.p2Y ?? 180, width: 680, height: 28 },
                lineCount: overrides?.lineCount ?? 1,
                focused: true,
                pressable: true,
              },
            ],
          },
          {
            id: "doc-block-p3",
            role: "group",
            bounds: { x: 320, y: overrides?.siblingY ?? 214, width: 680, height: 28 },
            pressable: false,
          },
        ],
      },
    ],
  };
}

describe("@vibevalley/vdp layout stability assertions", () => {
  it("passes when non-wrapping inline edit keeps lineCount and sibling geometry invariant even with floating overlays", () => {
    const before = makeDump();
    const afterBase = makeDump();
    const surface0 = afterBase.surfaces[0];
    if (!surface0) throw new Error("expected first surface");
    const after: VdpLayoutDump = {
      ...afterBase,
      surfaces: [
        {
          ...surface0,
          children: [
            ...(surface0.children ?? []),
            {
              id: "doc-format-bar-p2",
              role: "toolbar",
              bounds: { x: 400, y: 144, width: 160, height: 28 },
              pressable: false,
            },
            {
              id: "doc-presence-badge-session:s1",
              role: "status",
              bounds: { x: 860, y: 160, width: 140, height: 20 },
              pressable: false,
            },
          ],
        },
      ],
    };

    const flat = flattenLayoutDump(after);
    expect(flat.get("workbench::doc-block-input-p2")?.lineCount).toBe(1);
    const diff = assertInlineLayoutStable(before, after, { targetId: "doc-block-input-p2" });
    expect(diff.maxDeltaPx).toBe(0);
    expect(diff.shiftedNodes).toEqual([]);
  });

  it("rejects accidental line wrapping and sibling layout shifts", () => {
    const before = makeDump({ lineCount: 1, siblingY: 214 });
    const wrapped = makeDump({ lineCount: 2, siblingY: 242 });
    expect(() => assertInlineLayoutStable(before, wrapped, { targetId: "doc-block-input-p2" })).toThrow(/non-wrapping edit violated/u);

    const siblingShifted = makeDump({ lineCount: 1, siblingY: 222 });
    const diff = diffLayoutDumps(before, siblingShifted);
    expect(diff.shiftedNodes.map((s) => s.id)).toEqual(["doc-block-p3"]);
    expect(() => assertInlineLayoutStable(before, siblingShifted, { targetId: "doc-block-input-p2" })).toThrow(/shifted 1 node\(s\): doc-block-p3/u);
  });
});
