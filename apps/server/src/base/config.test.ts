import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vite-plus/test";
import { dbDir, loadConfig, serverAddress } from "./config.ts";

const temp = () => mkdtempSync(join(tmpdir(), "vibevalley-config-"));

test("the defaults, then the file, then the environment", () => {
  const home = temp();
  let c = loadConfig("", { VIBEVALLEY_HOME: home });
  expect([c.home, c.port, c.project.maxSessions, c.project.checkTimeoutSeconds, dbDir(c)]).toEqual([home, 8787, 3, 1200, join(home, "db")]);
  writeFileSync(join(home, "vibevalley.yaml"), "port: 9000\nsession:\n  stall_seconds: 60\nproject: { max_sessions: 5 }\ngit_emails: [a@x, b@x]\ndb: memory\n");
  const env = {
    VIBEVALLEY_HOME: home,
    VIBEVALLEY_PORT: "9100",
    VIBEVALLEY_PROJECT_CHECK_TIMEOUT_SECONDS: "45",
    VIBEVALLEY_PATROL_HEARTBEAT_MINUTES: "0.5",
    DEEPSEEK_API_KEY: "sk-env",
  };
  c = loadConfig("", env);
  expect(c.port).toBe(9100);
  expect(c.session.stallSeconds).toBe(60);
  expect(c.project.maxSessions).toBe(5);
  expect(c.project.checkTimeoutSeconds).toBe(45);
  expect(c.patrol.heartbeatMinutes).toBe(0.5);
  expect(c.deepseek.apiKey).toBe("sk-env");
  expect(c.gitEmails).toEqual(["a@x", "b@x"]);
  expect(dbDir(c)).toBe("memory");
  expect(c.schedule.tickMs).toBe(20_000);
  expect(loadConfig("", { ...env, VIBEVALLEY_GIT_EMAILS: "c@x,d@x,e@x" }).gitEmails).toHaveLength(3);
});

test("what it cannot read is refused", () => {
  expect(() => loadConfig(join(temp(), "missing.yaml"), { VIBEVALLEY_HOME: temp() })).toThrow();
  expect(() => loadConfig("", { VIBEVALLEY_HOME: temp(), VIBEVALLEY_PORT: "eighty" })).toThrow(/port/);
});

test("the server's own address is always loopback", () => {
  expect(serverAddress(loadConfig("", { VIBEVALLEY_HOME: temp(), VIBEVALLEY_HOST: "0.0.0.0", VIBEVALLEY_PORT: "9100" }))).toBe("127.0.0.1:9100");
});

test("pull requests", () => {
  const home = temp();
  const c = loadConfig("", { VIBEVALLEY_HOME: home });
  expect([c.github.prProjects, c.github.prPollSeconds]).toEqual([[], 180]);
  const env = { VIBEVALLEY_HOME: home, VIBEVALLEY_GITHUB_PR_PROJECTS: "one,two", VIBEVALLEY_GITHUB_PR_POLL_SECONDS: "12" };
  expect(loadConfig("", env).github).toEqual({ prProjects: ["one", "two"], prPollSeconds: 12 });
  expect(() => loadConfig("", { ...env, VIBEVALLEY_GITHUB_PR_POLL_SECONDS: "0" })).toThrow();
});
