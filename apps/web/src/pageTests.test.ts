// The page layer's boundary (docs/subsystems/foundation.md, the test pyramid): a page test goes into the system only
// through the page and the server as a user's browser does, with the fixtures, Playwright and the protocol's shapes;
// never through the page's code or the server's.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";

const dir = join(import.meta.dirname, "../test");
const allowed = /^(\.\/[\w-]+|@playwright\/test(\/reporter)?|@vibevalley\/protocol(\/schema)?|node:[\w/]+)$/;

test("page tests reach the system only through the browser, Playwright and the protocol", () => {
  const crossing = readdirSync(dir)
    .filter((f) => f.endsWith(".ts"))
    .flatMap((f) =>
      [...readFileSync(join(dir, f), "utf8").matchAll(/^\s*(?:import|export)\s+(?:type\s+)?(?:[^;'"]*?\s+from\s+)?"([^"]+)"/gms)]
        .map((m) => m[1]!)
        .filter((spec) => !allowed.test(spec))
        .map((spec) => `${f} imports ${spec}`),
    );
  expect(crossing).toEqual([]);
});
