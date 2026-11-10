import { expect, it } from "vite-plus/test";

import { staleNamesIn } from "./stale-names.ts";

const source = "apps/server/src/machine/executor.ts";

it("regression: browser worker feature detection is not a stale domain name", () => {
  const browser = "apps/web/src/features/voice/moss-worker.ts";
  expect(staleNamesIn(browser, 'if (typeof Worker !== "undefined") {}')).toEqual([]);
  expect(staleNamesIn(browser, "const worker: Worker = new Worker(url);")).toEqual([]);
  expect(staleNamesIn(browser, 'Object.defineProperty(window, "Worker", { value: undefined });')).toEqual([]);
  expect(staleNamesIn(browser, 'Object.defineProperty(profile, "Worker", { value: undefined });')).toHaveLength(1);
  expect(staleNamesIn(browser, "const worker = Worker;")).toHaveLength(1);
});

it("the farm's person is the user, while other things' owners stay", () => {
  for (const line of [
    "const ownerId = row.owner_id;",
    "if (actsForOwner(actor)) {}",
    'const kind = "owner";',
    "stageWantsOwner(stage)",
    "publishOwnerMentions()",
  ])
    expect(staleNamesIn(source, line)).toHaveLength(1);
  for (const line of [
    "const issue = yield* mailbox.ownerOf(trigger.id);",
    "threadOwnerOf(thread, sessions)",
    "const userId = row.user_id;",
    'const kind = "user";',
  ])
    expect(staleNamesIn(source, line)).toEqual([]);
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
  for (const line of ['import { Storage } from "#/storage/storage.ts";', "const ingress = yield* Ingress;", "worldBelowIngress()"])
    expect(staleNamesIn(source, line)).toHaveLength(1);
});
