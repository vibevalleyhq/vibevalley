import { existsSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { scriptedRuntime } from "@botiverse/oar/testing";
import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Context, Effect, Layer, Stream } from "effect";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { Mcp } from "#/gateway/mcp/mcp.ts";
import { Agent } from "#/modules/agent/agent.ts";
import { explicitMandate } from "#/modules/issue/creation.ts";
import { Issue } from "#/modules/issue/issue.ts";
import { Repo } from "#/modules/repo/repo.ts";
import { repository } from "#/modules/repo/repository.ts";
import { Session } from "#/modules/session/session.ts";
import { workerAccess } from "#/modules/session/worker.ts";
import { Tool } from "#/modules/tool/tool.ts";
import { gitIn } from "#/testing/git.ts";
import { starter, testConfig, until, waitFor } from "#/testing/layers.ts";
import { world } from "#/testing/world.ts";

const listen = Effect.fnUntraced(function* (mcp: Mcp["Service"]) {
  const node = createServer();
  const routes = HttpRouter.use((router) =>
    router.add(
      "POST",
      "/mcp",
      Effect.gen(function* () {
        const httpServerRequest = yield* HttpServerRequest.HttpServerRequest;
        const request = yield* HttpServerRequest.toWeb(httpServerRequest);
        const handle2 = yield* mcp.handle(request);
        return HttpServerResponse.fromWeb(handle2);
      }),
    ),
  );
  const listener = NodeHttpServer.layer(() => node, { host: "127.0.0.1", port: 0 });
  const http = yield* Layer.build(HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(Layer.provideMerge(listener)));
  const server = Context.get(http, HttpServer.HttpServer);
  if (server.address._tag === "UnixPathAddress") throw new Error("TCP required");
  yield* Effect.addFinalizer(() => Effect.sync(() => node.closeAllConnections()));
  return HttpServer.formatAddress(server.address) + "/mcp";
});

it.live("regression: worker CLI preserves returned tool errors and ignores unavailable user discovery", () =>
  Effect.gen(function* () {
    let isError = false;
    let calls = 0;
    const original = yield* Tool;
    const replacement = Tool.of({
      ...original,
      session: () => [
        {
          name: "session_list",
          description: "",
          parameters: {},
          execute: () =>
            Effect.sync(() => {
              calls++;
              return { content: [{ type: "text" as const, text: isError ? "Repository checks failed: valid " + "x".repeat(9000) : "result" }], isError };
            }),
        },
      ],
    });
    const ctx = yield* Layer.build(Mcp.layer({ who: (token) => (token === "valid" ? "worker" : "") }).pipe(Layer.provide(Layer.succeed(Tool, replacement))));
    const mcp = Context.get(ctx, Mcp);
    const endpoint = yield* listen(mcp);
    const cli = yield* workerAccess;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const access = yield* cli.prepare("fixture", endpoint, "valid");
    const run = () =>
      Effect.gen(function* () {
        const process = yield* spawner.spawn(
          ChildProcess.make("/bin/sh", ["-c", access.command + " doctor"], {
            env: {
              VIBEVALLEY_HOME: "/nonexistent-worker-home",
              VIBEVALLEY_SERVER: "http://127.0.0.1:1",
            },
          }),
        );
        const [code, output] = yield* Effect.all([process.exitCode, Stream.mkString(Stream.decodeText(process.all))], { concurrency: 2 });
        return { code, output };
      });
    expect((yield* run()).code).toBe(0);
    isError = true;
    const failed = yield* run();
    expect(failed.code).not.toBe(0);
    expect(failed.output).toContain("Repository checks failed:");
    expect(failed.output).not.toContain("valid");
    expect(failed.output.length).toBeLessThan(17000);
    expect(calls).toBe(3);
  }).pipe(Effect.scoped, Effect.provide(world())),
);

it.live("regression: a real worker CLI submits its authorized PR and report as its session", () => {
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
  return Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => gate.resolve()));
    const mcp = yield* Mcp;
    const endpoint = yield* listen(mcp);
    const sessions = yield* Session;
    sessions.setAddress(new URL(endpoint).host);
    const issues = yield* Issue;
    const agent = { ...starter("lab"), effort: "" };
    yield* (yield* Agent).save(agent);
    gitIn(config.workRoot, "init", "--bare", bare);
    gitIn(repo, "remote", "add", "origin", "https://github.com/test/demo.git");
    yield* (yield* Repo).refreshGitHub();
    const issue = yield* issues.add({ title: "work", repo: "demo", agent: "lab" }, explicitMandate("", true));
    yield* issues.start(issue.id, "");
    yield* until(() => token !== "", "worker environment");
    expect(injectedElectron).toBeUndefined();
    const id = sessions.who(token);
    expect(command).not.toBe("");
    expect(statSync(credentialFile).mode & 0o777).toBe(0o600);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const run = (operation: string) =>
      spawner.exitCode(
        ChildProcess.make("/bin/sh", ["-c", command + " " + operation], {
          env: {
            VIBEVALLEY_HOME: "/nonexistent-worker-home",
            VIBEVALLEY_SERVER: "http://127.0.0.1:1",
          },
        }),
      );
    const outcome = yield* run("pr-submit");
    expect(outcome).toBe(0);
    expect((yield* issues.get(issue.id)).pullRequest?.number).toBe(1);
    const outcome2 = yield* run(`report '{"summary":"CLI report","session":"someone-else","questions":[{"question":"Next?","options":["A","B"]}]}'`);
    expect(outcome2).toBe(0);
    gate.resolve();
    yield* waitFor(issues.get(issue.id), (item) => item.questions.length === 1, "CLI report");
    expect((yield* issues.get(issue.id)).questions[0]?.question).toBe("Next?");
    yield* sessions.dismiss(id);
    expect(sessions.who(token)).toBe("");
    expect(existsSync(credentialFile)).toBe(false);
    expect((yield* issues.get(issue.id)).questions[0]?.question).toBe("Next?");
  }).pipe(
    Effect.scoped,
    Effect.provide(
      world({
        config,
        workerAccess,
        runtimes: [runtime],
        repos: ["demo"],
        repoHooks: {
          gh: (...args) =>
            Effect.sync(() => {
              const ok = (out: string) => ({ out, ok: true, missing: false });
              if (args[0] === "--version") return ok("gh version 2.80.0");
              if (args[0] === "auth") return ok("Logged in to github.com account gardener (keyring)");
              if (args[0] === "repo") return ok('{"viewerPermission":"WRITE","defaultBranchRef":{"name":"main"}}');
              if (args[0] === "pr" && args[1] === "list") return ok("[]");
              if (args[0] === "pr" && args[1] === "create") return ok("https://github.com/test/demo/pull/1");
              return { out: "", ok: false, missing: false };
            }),
          publication: {
            tip: () => repository(repo).head,
            fetch: () => Effect.void,
            push: (cwd, _url, branch, sha) => repository(cwd).push(bare, branch, sha),
          },
          fetch: () => Effect.succeed(false),
        },
      }),
    ),
  );
});
