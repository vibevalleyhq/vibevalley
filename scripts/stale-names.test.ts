import { expect, it } from "vite-plus/test";

import { staleNamesIn } from "./stale-names.ts";

const source = "apps/server/src/executor/executor.ts";

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
