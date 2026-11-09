import { expect, it } from "vite-plus/test";

import { staleNamesIn } from "./stale-names.ts";

const source = "apps/server/src/executor/executor.ts";

it("regression: browser worker feature detection is not a stale domain name", () => {
  const browser = "apps/web/src/features/voice/moss-worker.ts";
  expect(staleNamesIn(browser, 'if (typeof Worker !== "undefined") {}')).toEqual([]);
  expect(staleNamesIn(browser, "const worker: Worker = new Worker(url);")).toEqual([]);
  expect(staleNamesIn(browser, 'Object.defineProperty(window, "Worker", { value: undefined });')).toEqual([]);
  expect(staleNamesIn(browser, 'Object.defineProperty(profile, "Worker", { value: undefined });')).toHaveLength(1);
  expect(staleNamesIn(browser, "const worker = Worker;")).toHaveLength(1);
});

it("regression: stale service names are rejected while Effect Config APIs remain valid", () => {
  for (const service of ["Config", "Settings"]) {
    for (const statement of [`const config = yield* ${service};`, `const config = (yield* ${service});`]) {
      const hits = staleNamesIn(source, statement);
      expect(hits).toHaveLength(1);
      expect(hits[0]).toContain(`${source}:1:`);
      expect(hits[0]).toContain("ServerConfig");
    }
  }
  expect(staleNamesIn(source, 'const value = yield* Config.String("NO_PROXY").pipe(Config.withDefault(""));')).toEqual([]);
  expect(staleNamesIn(source, 'const value = yield* Config . String("NO_PROXY");')).toEqual([]);
  expect(staleNamesIn(source, "const config = yield* ServerConfig;")).toEqual([]);
  expect(staleNamesIn(source, "const config = yield* Settings.get;")).toHaveLength(1);
  expect(staleNamesIn(source, "agents.saveAgent(input)")).toHaveLength(1);
});
