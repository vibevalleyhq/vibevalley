import { expect, test } from "vite-plus/test";

import { migrationProgress } from "./style-migration-progress";
import type { StyleFinding } from "./style-migration-scan";

const finding = (path: string, category = "unconverted-class-token"): StyleFinding => ({ path, category, offset: 0, evidence: "fixture" });

test("progress counts occurrences separately from distinct files", () => {
  const result = migrationProgress([
    finding("apps/web/src/ui/Button.tsx"),
    finding("apps/web/src/ui/Button.tsx"),
    finding("apps/web/src/features/issue/Board.tsx"),
    finding("apps/web/src/ui/Button.tsx", "unconverted-styled-contract"),
  ]);
  expect(result.classTokens).toBe(3);
  expect(result.filesWithClassTokens).toBe(2);
  expect(result.areas.find((area) => area.area === "apps/web/src/ui")).toEqual({
    area: "apps/web/src/ui",
    classTokens: 2,
    filesWithClassTokens: 1,
    categories: { "unconverted-class-token": 2, "unconverted-styled-contract": 1 },
  });
});

test("regression: progress retains unknown areas, categories and blocking evidence", () => {
  const input = [
    finding("apps/new-client/src/Main.tsx"),
    finding("apps/web/src/ui-extra/Main.tsx"),
    finding("apps/site/dist/client/main.css", "tailwind-css"),
    finding(".test/style-migration/graphs/app-client.json", "stale-build-inputs"),
    finding("new-source", "future-scanner-category"),
  ];
  const result = migrationProgress(input);
  expect(result.areas.map((area) => area.area)).toEqual(["apps/site", "apps/web", "other"]);
  expect(result.areas.flatMap((area) => Object.values(area.categories)).reduce((sum, count) => sum + count, 0)).toBe(input.length);
  expect(result.areas.find((area) => area.area === "other")?.categories).toEqual({
    "unconverted-class-token": 1,
    "stale-build-inputs": 1,
    "future-scanner-category": 1,
  });
  expect(result.classTokens).toBe(2);
});

test("progress totals reconcile with disjoint areas regardless of input order", () => {
  const input = [finding("apps/site/src/Hero.tsx"), finding("packages/stories/src/StoriesApp.tsx"), finding("apps/web/src/farm/Scene.tsx")];
  const result = migrationProgress(input);
  expect(migrationProgress(input.toReversed())).toEqual(result);
  expect(result.areas.reduce((sum, area) => sum + area.classTokens, 0)).toBe(result.classTokens);
  expect(result.areas.reduce((sum, area) => sum + area.filesWithClassTokens, 0)).toBe(result.filesWithClassTokens);
});

test("an empty progress summary does not assert acceptance", () => {
  expect(migrationProgress([])).toEqual({ classTokens: 0, filesWithClassTokens: 0, areas: [] });
});
