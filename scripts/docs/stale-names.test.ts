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
    "const issue = await mailbox.ownerOf(trigger.id);",
    "threadOwnerOf(thread, sessions)",
    "const userId = row.user_id;",
    'const kind = "user";',
  ])
    expect(staleNamesIn(source, line)).toEqual([]);
});

it("regression: stale service names are rejected while the config and the Setting service remain valid", () => {
  for (const statement of ["readonly settings: ServerConfig;", "const home = deps.settings.home;"]) {
    const hits = staleNamesIn(source, statement);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toContain(`${source}:1:`);
    expect(hits[0]).toContain("ServerConfig");
  }
  expect(staleNamesIn(source, "readonly config: ServerConfig;")).toEqual([]);
  expect(staleNamesIn(source, "const home = deps.config.home;")).toEqual([]);
  expect(staleNamesIn(source, "const key = await deps.setting.get();")).toEqual([]);
  expect(staleNamesIn(source, "agents.saveAgent(input)")).toHaveLength(1);
  for (const line of ['import { Storage } from "#/storage/storage.ts";', "const ingress: Ingress = deps.ingress;", "worldBelowIngress()"])
    expect(staleNamesIn(source, line)).toHaveLength(1);
});

it("regression: native mac workbench UI, Rust crates, and i18n catalogs enforce glossary terms", () => {
  expect(staleNamesIn("apps/mac/ui/features/issue/IssueCard.tsx", 'const kind = "owner";')).toHaveLength(1);
  expect(staleNamesIn("apps/mac/ui/features/issue/IssueCard.tsx", "const t = '地里';")).toHaveLength(1);
  expect(staleNamesIn("apps/mac/ui/farm/hud/Hud.tsx", "const t = '收获';")).toEqual([]);
  expect(staleNamesIn("crates/vibevalley-server/src/modules/work/issue/board.rs", 'let msg = "问主人";')).toHaveLength(1);
  expect(staleNamesIn("crates/vibevalley-i18n/locales/zh/cli.json", '{ "help": "问管家" }')).toHaveLength(1);
  expect(staleNamesIn("crates/vibevalley-i18n/locales/zh/server.issue.json", '{ "done": "收获了" }')).toHaveLength(1);
  expect(staleNamesIn("crates/vibevalley-i18n/locales/zh/server.game.json", '{ "done": "收获了" }')).toEqual([]);
  expect(staleNamesIn("crates/vibevalley-i18n/locales/zh/web.farm.hud.json", '{ "done": "收获了" }')).toEqual([]);
  expect(staleNamesIn("crates/vibevalley-i18n/locales/zh/web.issue.json", '{ "done": "收获了" }')).toHaveLength(1);
});
