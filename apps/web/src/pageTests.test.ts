import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { edgesOf } from "@vibevalley/testkit/source";

const dir = join(import.meta.dirname, "../test");
const allowed = /^(\.\/[\w-]+|@playwright\/test(\/reporter)?|@axe-core\/playwright|@vibevalley\/protocol(\/schema)?|node:[\w/]+)$/u;

test("browser imports accept fixtures but refuse product and test-runner shortcuts", () => {
  for (const spec of ["./stories-fixtures", "./fixtures", "@playwright/test", "@vibevalley/protocol/schema"]) expect(allowed.test(spec), spec).toBe(true);
  for (const spec of ["#/features/issue/IssuesPage", "../src/infra/query", "vite-plus/test", "./projects.test", "./projects.test.ts"])
    expect(allowed.test(spec), spec).toBe(false);
});

test("browser specs and fixtures reach the system only through the browser, Playwright and the protocol", () => {
  const crossing = readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
    .flatMap((f) =>
      edgesOf(f, readFileSync(join(dir, f), "utf8"))
        .map((e) => e.from)
        .filter((spec) => !allowed.test(spec))
        .map((spec) => `${f} imports ${spec}`),
    );
  expect(
    crossing,
    "a browser spec or fixture goes in only as a user's browser does: through the fixtures, Playwright and the protocol's shapes. Fix: drive it through the page (stories-fixtures.ts for components, fixtures.ts for integration); Node-only infrastructure checks belong in *.test.ts, which browser specs and fixtures cannot import. See docs/subsystems/foundation.md",
  ).toEqual([]);
});
