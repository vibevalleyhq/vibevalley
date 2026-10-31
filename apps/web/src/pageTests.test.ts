// The page layer's boundary (docs/subsystems/foundation.md, the test pyramid): a page test goes into the system only
// through the page and the server as a user's browser does, with the fixtures, Playwright and the protocol's shapes;
// never through the page's code or the server's.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { edgesOf } from "@vibevalley/testkit/source";

const dir = join(import.meta.dirname, "../test");
const allowed = /^(\.\/[\w-]+|@playwright\/test(\/reporter)?|@axe-core\/playwright|@vibevalley\/protocol(\/schema)?|node:[\w/]+)$/u;

test("page tests reach the system only through the browser, Playwright and the protocol", () => {
  const crossing = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) =>
      edgesOf(f, readFileSync(join(dir, f), "utf8"))
        .map((e) => e.from)
        .filter((spec) => !allowed.test(spec))
        .map((spec) => `${f} imports ${spec}`),
    );
  expect(
    crossing,
    "a page test goes in only as a user's browser does: through the fixtures, Playwright and the protocol's shapes. Fix: drive it through the page (fixtures.ts for the server it talks to); a judgement the page makes is a pure function in features/<concept> with its own vitest test. See docs/subsystems/foundation.md",
  ).toEqual([]);
});
