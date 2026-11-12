import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { VibeValleyApi } from "@vibevalley/protocol";
import { BizCode } from "@vibevalley/protocol/api";
import { tempDir } from "@vibevalley/testkit/temp";

import { gitSync, repo } from "#/testing/git.ts";
import { app } from "#/testing/http.ts";
import { testConfig } from "#/testing/layers.ts";
import { quietApp } from "#/testing/world.ts";

test("the user previews an external checkout over HTTP and bearer callers are refused", async () => {
  const cwd = join(tempDir("publish-http-"), "external");
  repo(cwd, 1, 0);
  gitSync(cwd, "checkout", "-b", "feat/http");
  gitSync(cwd, "remote", "add", "origin", "https://gitlab.com/group/repo.git");
  await using served = await app(testConfig(), 0, undefined, {
    ...quietApp,
    repo: {
      ...quietApp.repo,
      glab: async (...args) => ({ ok: true, missing: false, out: args[0] === "auth" ? "" : '{"default_branch":"main"}' }),
    },
  });
  const address = served.address;
  const request = { cwd, branch: "feat/http", sha: gitSync(cwd, "rev-parse", "HEAD"), base: "main", title: "HTTP", body: "Body", dryRun: true };
  const api = new VibeValleyApi(`http://${address}`);
  const preview = await api.repo.pr.submit(request);
  expect(preview).toMatchObject({ pushed: false, check: "preview", platform: "gitlab" });
  const refused = await fetch(`http://${address}/api/v1/repo/pr/submit`, {
    method: "POST",
    headers: { authorization: "Bearer worker-token", "content-type": "application/json" },
    body: JSON.stringify(request),
  });
  expect(refused.status).toBe(409);
  const json2: unknown = await refused.json();
  expect(json2).toMatchObject({ bizCode: BizCode.RepoRefused });
  expect(gitSync(cwd, "status", "--porcelain")).toBe("");
});
