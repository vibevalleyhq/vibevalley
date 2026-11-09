import { expect, test } from "vite-plus/test";

import { scanStyleDependencies } from "./style-migration-dependencies";

const formatter = {
  snapshots: {
    "oxfmt@1.0.0": { optionalDependencies: { "@astrojs/compiler-rs": "1.0.0" } },
    "@astrojs/compiler-rs@1.0.0": { dependencies: { "@astrojs/compiler-binding": "1.0.0" } },
    "@astrojs/compiler-binding@1.0.0": { optionalDependencies: { "@astrojs/compiler-binding-linux-x64-gnu": "1.0.0" } },
    "@astrojs/compiler-binding-linux-x64-gnu@1.0.0": {},
  },
};

test("formatter-only Astro parsers are classified separately from the website framework", () => {
  const result = scanStyleDependencies("pnpm-lock.yaml", [{ settings: {} }, formatter]);
  expect(result.findings).toEqual([]);
  expect(result.classifications.length).toBe(6);
  expect(result.classifications.every((classification) => classification.kind.startsWith("formatter-only-parser:"))).toBe(true);
});

test("formatter classification cannot hide a direct website compiler dependency", () => {
  const result = scanStyleDependencies("pnpm-lock.yaml", [
    { importers: { "apps/site": { dependencies: { "@astrojs/compiler-rs": { version: "1.0.0" } } } } },
    formatter,
  ]);
  expect(result.findings.length).toBeGreaterThan(0);
  expect(result.classifications).toEqual([]);
});

test("formatter classification cannot hide a compiler imported through an alias", () => {
  const result = scanStyleDependencies("pnpm-lock.yaml", [
    { importers: { "apps/site": { dependencies: { compiler: { version: "@astrojs/compiler-rs@1.0.0" } } } } },
    formatter,
  ]);
  expect(result.findings.length).toBeGreaterThan(0);
  expect(result.classifications).toEqual([]);
});

test("a second consumer makes the parser a genuine dependency", () => {
  const result = scanStyleDependencies("pnpm-lock.yaml", {
    snapshots: { ...formatter.snapshots, "website-build@1.0.0": { dependencies: { "@astrojs/compiler-rs": "1.0.0" } } },
  });
  expect(result.findings.length).toBeGreaterThan(0);
  expect(result.classifications).toEqual([]);
});

test("optional peers are metadata, required peers and Tailwind helpers are findings", () => {
  const result = scanStyleDependencies("package.json", {
    peerDependencies: { astro: "*", tailwindcss: "*" },
    peerDependenciesMeta: { astro: { optional: true } },
    dependencies: { "tailwind-merge": "catalog:", "prettier-plugin-tailwindcss": "catalog:" },
  });
  expect(result.classifications.map((classification) => classification.kind)).toEqual(["optional-peer-metadata:astro"]);
  expect(result.findings.map((finding) => finding.category)).toEqual(["tailwind-dependency", "tailwind-dependency", "tailwind-dependency"]);
});
