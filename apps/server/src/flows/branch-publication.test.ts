import { join } from "node:path";

import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";

import { VibeValleyApi } from "@vibevalley/protocol";
import { tempDir } from "@vibevalley/testkit/temp";

import { app } from "#/http/app.ts";
import { gitSync, repo } from "#/testing/git.ts";
import { testConfig } from "#/testing/layers.ts";
import { quietApp } from "#/testing/world.ts";

it.live("the owner previews an external checkout over HTTP and bearer callers are refused", () =>
  Effect.gen(function* () {
    const cwd = join(tempDir("publish-http-"), "external");
    repo(cwd, 1, 0);
    gitSync(cwd, "checkout", "-b", "feat/http");
    gitSync(cwd, "remote", "add", "origin", "https://gitlab.com/group/repo.git");
    let address = "";
    yield* Layer.build(
      app(
        testConfig(),
        0,
        (a) =>
          Effect.sync(() => {
            address = a;
          }),
        {
          ...quietApp,
          repo: {
            ...quietApp.repo,
            glab: (...args) => Effect.succeed({ ok: true, missing: false, out: args[0] === "auth" ? "" : '{"default_branch":"main"}' }),
          },
        },
      ),
    );
    const request = { cwd, branch: "feat/http", sha: gitSync(cwd, "rev-parse", "HEAD"), base: "main", title: "HTTP", body: "Body", dryRun: true };
    const api = new VibeValleyApi(`http://${address}`);
    const preview = yield* Effect.promise(() => api.repo.pr.submit(request));
    expect(preview).toMatchObject({ pushed: false, check: "preview", platform: "gitlab" });
    const refused = yield* Effect.promise(() =>
      fetch(`http://${address}/api/v1/repo/pr/submit`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer worker-token" },
        body: JSON.stringify(request),
      }),
    );
    expect(refused.status).toBe(409);
    expect(yield* Effect.promise(() => refused.json())).toMatchObject({ _tag: "Refused" });
    expect(gitSync(cwd, "status", "--porcelain")).toBe("");
  }).pipe(Effect.scoped),
);
