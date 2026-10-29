import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeServices } from "@effect/platform-node";
import { Effect } from "effect";
import { expect, test } from "vite-plus/test";
import { type ConfigShape, dbDir, loadConfig, serverAddress } from "./config.ts";

const temp = () => mkdtempSync(join(tmpdir(), "vibevalley-config-"));
const load = (file: string, env: Record<string, string>) => Effect.runPromise(loadConfig(file, env).pipe(Effect.provide(NodeServices.layer)));
const refused = (file: string, env: Record<string, string>) =>
  Effect.runPromise(Effect.flip(loadConfig(file, env)).pipe(Effect.provide(NodeServices.layer))).then((e) => e.message);

test("the defaults, then the file, then the environment", async () => {
  const home = temp();
  let c: ConfigShape = await load("", { VIBEVALLEY_HOME: home });
  expect([c.home, c.port, c.project.maxSessions, c.project.checkTimeoutSeconds, dbDir(c)]).toEqual([home, 8787, 3, 1200, join(home, "db")]);
  writeFileSync(join(home, "vibevalley.yaml"), "port: 9000\nsession:\n  stall_seconds: 60\nproject: { max_sessions: 5 }\ngit_emails: [a@x, b@x]\ndb: memory\n");
  const env = {
    VIBEVALLEY_HOME: home,
    VIBEVALLEY_PORT: "9100",
    VIBEVALLEY_PROJECT_CHECK_TIMEOUT_SECONDS: "45",
    VIBEVALLEY_PATROL_HEARTBEAT_MINUTES: "0.5",
    DEEPSEEK_API_KEY: "sk-env",
  };
  c = await load("", env);
  expect(c.port).toBe(9100);
  expect(c.session.stallSeconds).toBe(60);
  expect(c.project.maxSessions).toBe(5);
  expect(c.project.checkTimeoutSeconds).toBe(45);
  expect(c.patrol.heartbeatMinutes).toBe(0.5);
  expect(c.deepseek.apiKey).toBe("sk-env");
  expect(c.gitEmails).toEqual(["a@x", "b@x"]);
  expect(dbDir(c)).toBe("memory");
  expect(c.cron.tickMs).toBe(20_000);
  expect((await load("", { ...env, VIBEVALLEY_GIT_EMAILS: "c@x, d@x,e@x" })).gitEmails).toEqual(["c@x", "d@x", "e@x"]);
  expect((await load("", { ...env, VIBEVALLEY_DEEPSEEK_API_KEY: "sk-farm" })).deepseek.apiKey).toBe("sk-farm");
  expect((await load("", { ...env, VIBEVALLEY_GIT_EMAILS: "" })).gitEmails).toEqual([]);
});

test("what it cannot read is refused", async () => {
  expect(await refused(join(temp(), "missing.yaml"), { VIBEVALLEY_HOME: temp() })).toContain("没有这个文件");
  expect(await refused("", { VIBEVALLEY_HOME: temp(), VIBEVALLEY_PORT: "eighty" })).toMatch(/port/);
  expect(await refused("", { VIBEVALLEY_HOME: temp(), VIBEVALLEY_LAN_PORT: "70000" })).toContain("lan.port 不是端口");
});

test("the server's own address is always loopback", async () => {
  expect(serverAddress(await load("", { VIBEVALLEY_HOME: temp(), VIBEVALLEY_HOST: "0.0.0.0", VIBEVALLEY_PORT: "9100" }))).toBe("127.0.0.1:9100");
});

test("pull requests", async () => {
  const home = temp();
  const c = await load("", { VIBEVALLEY_HOME: home });
  expect([c.github.prProjects, c.github.prPollSeconds]).toEqual([[], 180]);
  const env = { VIBEVALLEY_HOME: home, VIBEVALLEY_GITHUB_PR_PROJECTS: "one,two", VIBEVALLEY_GITHUB_PR_POLL_SECONDS: "12" };
  expect((await load("", env)).github).toEqual({ prProjects: ["one", "two"], prPollSeconds: 12 });
  expect(await refused("", { ...env, VIBEVALLEY_GITHUB_PR_POLL_SECONDS: "0" })).toContain("pr_poll_seconds");
});
