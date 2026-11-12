import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { tempDir } from "@vibevalley/testkit/temp";

import { type ServerConfig, dbDir, loadConfig, pkmDir, reposDir, serverAddress, worktreesDir } from "./config.ts";

const temp = () => tempDir("vibevalley-config-");
const load = loadConfig;
const refused = (file: string, env: Record<string, string>) =>
  loadConfig(file, env).then(
    () => "",
    (e: unknown) => (e instanceof Error ? e.message : String(e)),
  );

test("the defaults, then the file, then the environment", async () => {
  const home = temp();
  let c: ServerConfig = await load("", { VIBEVALLEY_HOME: home });
  expect([c.home, c.port, c.repo.maxSessions, c.repo.checkTimeoutSeconds, dbDir(c)]).toEqual([home, 8787, 3, 1200, join(home, "db")]);
  writeFileSync(join(home, "vibevalley.yaml"), "port: 9000\nsession:\n  stall_seconds: 60\nrepo: { max_sessions: 5 }\ngit_emails: [a@x, b@x]\ndb: memory\n");
  const env = {
    VIBEVALLEY_HOME: home,
    VIBEVALLEY_PORT: "9100",
    VIBEVALLEY_REPO_CHECK_TIMEOUT_SECONDS: "45",
    VIBEVALLEY_PATROL_HEARTBEAT_MINUTES: "0.5",
    DEEPSEEK_API_KEY: "sk-env",
  };
  c = await load("", env);
  expect(c.port).toBe(9100);
  expect(c.session.stallSeconds).toBe(60);
  expect(c.repo.maxSessions).toBe(5);
  expect(c.repo.checkTimeoutSeconds).toBe(45);
  expect(c.patrol.heartbeatMinutes).toBe(0.5);
  expect(c.deepseek.apiKey.reveal()).toBe("sk-env");
  expect(c.gitEmails).toEqual(["a@x", "b@x"]);
  expect(dbDir(c)).toBe("memory");
  expect(c.cron.tickMs).toBe(20_000);
  expect((await load("", { ...env, VIBEVALLEY_GIT_EMAILS: "c@x, d@x,e@x" })).gitEmails).toEqual(["c@x", "d@x", "e@x"]);
  const farm = await load("", { ...env, VIBEVALLEY_DEEPSEEK_API_KEY: "sk-farm" });
  expect(farm.deepseek.apiKey.reveal()).toBe("sk-farm");
  expect((await load("", { ...env, VIBEVALLEY_GIT_EMAILS: "" })).gitEmails).toEqual([]);
});

test("what it cannot read is refused", async () => {
  const refused2 = await refused(join(temp(), "missing.yaml"), { VIBEVALLEY_HOME: temp() });
  expect(refused2).toContain("没有这个文件");
  const refused3 = await refused("", { VIBEVALLEY_HOME: temp(), VIBEVALLEY_PORT: "eighty" });
  expect(refused3).toMatch(/port/iu);
  const refused4 = await refused("", { VIBEVALLEY_HOME: temp(), VIBEVALLEY_LAN_PORT: "70000" });
  expect(refused4).toContain("lan.port 不是端口");
});

test("the server's own address is always loopback", async () => {
  const found = await load("", { VIBEVALLEY_HOME: temp(), VIBEVALLEY_HOST: "0.0.0.0", VIBEVALLEY_PORT: "9100" });
  expect(serverAddress(found)).toBe("127.0.0.1:9100");
});

test("a space keeps its repos, worktrees and notes under its work root", async () => {
  const home = temp();
  const c = await load("", { VIBEVALLEY_HOME: home });
  expect([reposDir(c), worktreesDir(c), pkmDir(c)]).toEqual([join(c.workRoot, "repos"), join(c.workRoot, "worktrees"), join(c.workRoot, "pkm")]);
  const notes = join(home, "notes");
  const own = await load("", { VIBEVALLEY_HOME: home, VIBEVALLEY_PKM_ROOT: notes });
  expect(pkmDir(own)).toBe(notes);
});

test("pull requests", async () => {
  const home = temp();
  const c = await load("", { VIBEVALLEY_HOME: home });
  expect([c.github.prRepos, c.github.prPollSeconds]).toEqual([[], 180]);
  const env = { VIBEVALLEY_HOME: home, VIBEVALLEY_GITHUB_PR_REPOS: "one,two", VIBEVALLEY_GITHUB_PR_POLL_SECONDS: "12" };
  expect((await load("", env)).github).toEqual({ prRepos: ["one", "two"], prPollSeconds: 12 });
  const refused2 = await refused("", { ...env, VIBEVALLEY_GITHUB_PR_POLL_SECONDS: "0" });
  expect(refused2).toContain("pr_poll_seconds");
});
