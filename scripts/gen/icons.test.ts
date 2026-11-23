import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { EXPECTED_ICON_COUNT, assertIconNameParity, generateIconTargets, parseRustIcons, parseTsIconNames, renderIconPathsTs, runIconsGen } from "./icons.ts";

const root = resolve(import.meta.dirname, "../..");

describe("crates/rich/src/icon.rs SSOT icon generator", () => {
  const rustSource = readFileSync(resolve(root, "crates/rich/src/icon.rs"), "utf8");
  const macIconsSource = readFileSync(resolve(root, "apps/mac/ui/design/icons.ts"), "utf8");

  it("extracts all 98 icons with non-empty SVG paths and exact parity with apps/mac/ui/design/icons.ts", () => {
    const entries = parseRustIcons(rustSource);
    const tsNames = parseTsIconNames(macIconsSource);

    expect(entries).toHaveLength(EXPECTED_ICON_COUNT);
    expect(tsNames).toHaveLength(EXPECTED_ICON_COUNT);
    assertIconNameParity(
      entries.map((e) => e.name),
      tsNames,
      "apps/mac/ui/design/icons.ts",
    );

    const byName = new Map(entries.map((e) => [e.name, e.shapes]));
    for (const entry of entries) {
      expect(entry.shapes.length, entry.name).toBeGreaterThan(0);
      for (const shape of entry.shapes) {
        expect(shape.d.trim().length, entry.name).toBeGreaterThan(0);
        expect(shape.fill || (shape.stroke !== undefined && shape.stroke > 0), entry.name).toBe(true);
      }
    }

    // Spot-check all three helper constructors from crates/rich/src/icon.rs.
    expect(byName.get("chat")?.[0]).toMatchObject({ fill: true, evenodd: true });
    expect(byName.get("close")?.[0]).toMatchObject({ fill: true });
    expect(byName.get("close")?.[0]?.evenodd).toBeUndefined();
    expect(byName.get("add")).toEqual([
      { d: "M6 12H18", fill: false, stroke: 1.5, cap: "round", join: "round" },
      { d: "M12 18V6", fill: false, stroke: 1.5, cap: "round", join: "round" },
    ]);
  });

  it("parses explicit IconShape struct literals preserving evenodd, stroke, cap, join, and opacity", () => {
    const fixture = `
      pub const ICON_NAMES: &[&str] = &["custom", "rawStroke"];
      const ICON_SHAPES: [&[IconShape]; 2] = [
        &[
          IconShape {
            d: "M2 2H22V22H2Z",
            fill: true,
            stroke: None,
            cap: LineCap::Butt,
            join: LineJoin::Miter,
            evenodd: true,
            opacity: Some(0.4),
          },
          IconShape {
            d: "M4 12H20",
            fill: false,
            stroke: Some(1.75),
            cap: LineCap::Square,
            join: LineJoin::Bevel,
            evenodd: false,
            opacity: Some(0.85),
          },
        ],
        &[
          IconShape {
            d: r#"M6 6L18 18"#,
            fill: false,
            stroke: Some(2.0),
            cap: LineCap::Round,
            join: LineJoin::Round,
            evenodd: false,
            opacity: None,
          },
        ],
      ];
    `;
    const parsed = parseRustIcons(fixture);
    expect(parsed).toEqual([
      {
        name: "custom",
        shapes: [
          { d: "M2 2H22V22H2Z", fill: true, evenodd: true, opacity: 0.4 },
          { d: "M4 12H20", fill: false, stroke: 1.75, cap: "square", join: "bevel", opacity: 0.85 },
        ],
      },
      {
        name: "rawStroke",
        shapes: [{ d: "M6 6L18 18", fill: false, stroke: 2, cap: "round", join: "round" }],
      },
    ]);

    const rendered = renderIconPathsTs(parsed);
    expect(rendered).toContain("evenodd: true, opacity: 0.4");
    expect(rendered).toContain('stroke: 1.75, cap: "square", join: "bevel", opacity: 0.85');
  });

  it("is deterministic, passes --check against committed targets, and emits apps/mobile/design/iconPaths.gen.ts when present", () => {
    const first = generateIconTargets(root);
    const second = generateIconTargets(root);
    expect(first).toEqual(second);
    expect(runIconsGen(true, root)).toEqual([]);

    const tempDir = mkdtempSync(join(tmpdir(), "vv-icons-gen-"));
    try {
      mkdirSync(join(tempDir, "crates/rich/src"), { recursive: true });
      mkdirSync(join(tempDir, "apps/mac/ui/design"), { recursive: true });
      mkdirSync(join(tempDir, "apps/mobile/design"), { recursive: true });
      writeFileSync(join(tempDir, "crates/rich/src/icon.rs"), rustSource, "utf8");
      writeFileSync(join(tempDir, "apps/mac/ui/design/icons.ts"), macIconsSource, "utf8");
      writeFileSync(join(tempDir, "apps/mobile/design/icons.ts"), macIconsSource, "utf8");

      const initialDrift = runIconsGen(true, tempDir);
      expect(initialDrift).toEqual([join(tempDir, "apps/mac/ui/design/iconPaths.gen.ts"), join(tempDir, "apps/mobile/design/iconPaths.gen.ts")]);

      runIconsGen(false, tempDir);
      expect(runIconsGen(true, tempDir)).toEqual([]);
      expect(readFileSync(join(tempDir, "apps/mobile/design/iconPaths.gen.ts"), "utf8")).toBe(
        readFileSync(join(tempDir, "apps/mac/ui/design/iconPaths.gen.ts"), "utf8"),
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
