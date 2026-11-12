// oxlint-disable-next-line vibevalley/child-process-door -- the test runs the worker CLI as a helper would, through a shell, and reads all it printed
import { spawn } from "node:child_process";
import { existsSync, statSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { createAdaptorServer } from "@hono/node-server";
import { expect, test } from "vite-plus/test";

import { makeMcp, type Mcp } from "#/gateway/mcp/mcp.ts";
import { explicitMandate } from "#/modules/issue/creation.ts";
import { repository } from "#/modules/repo/repository.ts";
import { workerAccess } from "#/modules/session/worker.ts";
import type { Tool } from "#/modules/tool/tool.ts";
import { gitIn } from "#/testing/git.ts";
import { starter, testConfig, until, waitFor } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";

/** /mcp served on a free loopback port: its address, closed with await using. */
async function listen(mcp: Mcp) {
  const node = createAdaptorServer({ fetch: (request: Request) => mcp.handle(request) });
  await new Promise<void>((resolve) => node.listen(0, "127.0.0.1", () => resolve()));
  const { port } = node.address() as AddressInfo;
  return {
    endpoint: `127.0.0.1:${port}/mcp`,
    [Symbol.asyncDispose]: () =>
      new Promise<void>((resolve) => {
        if ("closeAllConnections" in node) node.closeAllConnections();
        node.close(() => resolve());
      }),
  };
}

/** The shell command's exit code and everything it wrote, stdout and stderr together. */
function sh(command: string, env: Record<string, string>) {
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    const child = spawn("/bin/sh", ["-c", command], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (output += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (output += d));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? -1, output }));
  });
}

const cliEnv = { VIBEVALLEY_HOME: "/nonexistent-worker-home", VIBEVALLEY_SERVER: "http://127.0.0.1:1" };

test("regression: worker CLI preserves returned tool errors and ignores unavailable user discovery", async () => {
  await using fw = await world();
  let isError = false;
  let calls = 0;
  const original = fw.tool;
  const replacement: Tool = {
    ...original,
    session: () => [
      {
        name: "session_list",
        description: "",
        parameters: {},
        execute: async () => {
          calls++;
          return { content: [{ type: "text" as const, text: isError ? "Repository checks failed: valid " + "x".repeat(9000) : "result" }], isError };
        },
      },
    ],
  };
  const mcp = await makeMcp({ ...fw, tool: replacement }, { who: (token) => (token === "valid" ? "worker" : "") });
  try {
    await using served = await listen(mcp);
    await using cli = await workerAccess();
    const access = await cli.prepare("fixture", "http://" + served.endpoint, "valid");
    const run = () => sh(access.command + " doctor", cliEnv);
    expect((await run()).code).toBe(0);
    isError = true;
    const failed = await run();
    expect(failed.code).not.toBe(0);
    expect(failed.output).toContain("Repository checks failed:");
    expect(failed.output).not.toContain("valid");
    expect(failed.output.length).toBeLessThan(17000);
    expect(calls).toBe(3);
  } finally {
    await mcp.close();
  }
});

test("regression: a real worker CLI submits its authorized PR and report as its session", async () => {
  const base = testConfig();
  const config = { ...base, github: { ...base.github, prRepos: ["demo"] } };
  const gate = Promise.withResolvers<void>();
  let turns = 0;
  let token = "";
  let command = "";
  let credentialFile = "";
  let injectedElectron: string | undefined;
  const runtime = scriptedRuntime({
    id: "pi",
    turn: async (turn) => {
      writeFileSync(join(turn.options.cwd, "work.txt"), "done " + ++turns);
      gitIn(turn.options.cwd, "add", ".");
      gitIn(turn.options.cwd, "commit", "-qm", "Complete work");
      for (const entry of turn.options.mcpServers ?? [])
        if (entry.name === "vibevalley" && "headers" in entry) token = (entry.headers.authorization ?? "").replace(/^Bearer /u, "");
      command = /必需的会话 CLI：([^\n]+)/u.exec(turn.options.appendSystemPrompt ?? turn.options.systemPrompt ?? turn.input)?.[1] ?? "";
      credentialFile = /--worker-access-file '([^']+)'/u.exec(command)?.[1] ?? "";
      injectedElectron = turn.options.env?.ELECTRON_RUN_AS_NODE ?? undefined;
      await gate.promise;
      turn.say("ready");
    },
  });
  const bare = join(config.workRoot, "origin.git");
  const repo = join(config.workRoot, "repos", "demo");
  await using fw = await world({
    config,
    workerAccess,
    runtimes: [runtime],
    repos: ["demo"],
    repoHooks: {
      gh: async (...args) => {
        const ok = (out: string) => ({ out, ok: true, missing: false });
        if (args[0] === "--version") return ok("gh version 2.80.0");
        if (args[0] === "auth") return ok("Logged in to github.com account gardener (keyring)");
        if (args[0] === "repo") return ok('{"viewerPermission":"WRITE","defaultBranchRef":{"name":"main"}}');
        if (args[0] === "pr" && args[1] === "list") return ok("[]");
        if (args[0] === "pr" && args[1] === "create") return ok("https://github.com/test/demo/pull/1");
        return { out: "", ok: false, missing: false };
      },
      publication: {
        tip: () => repository(repo).head(),
        fetch: () => Promise.resolve(),
        push: (cwd, _url, branch, sha) => repository(cwd).push(bare, branch, sha),
      },
      fetch: () => Promise.resolve(false),
    },
  });
  try {
    await using served = await listen(fw.mcp);
    const sessions = fw.session;
    sessions.setAddress(new URL("http://" + served.endpoint).host);
    const issues = fw.issue;
    const agent = { ...starter("lab"), effort: "" };
    await fw.agent.save(agent);
    gitIn(config.workRoot, "init", "--bare", bare);
    gitIn(repo, "remote", "add", "origin", "https://github.com/test/demo.git");
    await fw.repo.refreshGitHub();
    const issue = await issues.add({ title: "work", repo: "demo", agent: "lab" }, explicitMandate("", true));
    await issues.start(issue.id, "");
    await until(() => token !== "", "worker environment");
    expect(injectedElectron).toBeUndefined();
    const id = sessions.who(token);
    expect(command).not.toBe("");
    expect(statSync(credentialFile).mode & 0o777).toBe(0o600);
    const run = async (operation: string) => (await sh(command + " " + operation, cliEnv)).code;
    const outcome = await run("pr-submit");
    expect(outcome).toBe(0);
    expect((await issues.get(issue.id)).pullRequest?.number).toBe(1);
    const outcome2 = await run(`report '{"summary":"CLI report","session":"someone-else","questions":[{"question":"Next?","options":["A","B"]}]}'`);
    expect(outcome2).toBe(0);
    gate.resolve();
    await waitFor(
      () => issues.get(issue.id),
      (item) => item.questions.length === 1,
      "CLI report",
    );
    expect((await issues.get(issue.id)).questions[0]?.question).toBe("Next?");
    await sessions.dismiss(id);
    expect(sessions.who(token)).toBe("");
    expect(existsSync(credentialFile)).toBe(false);
    expect((await issues.get(issue.id)).questions[0]?.question).toBe("Next?");
  } finally {
    gate.resolve();
  }
});
