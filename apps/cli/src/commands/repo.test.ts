import { expect, it } from "vite-plus/test";

import { endpoints } from "@vibevalley/protocol/api";

import { cli } from "#/testing/cli.ts";
import { fakeServer } from "#/testing/http.ts";

it("repo pr submit sends the explicit checkout and dry-run to the server", async () => {
  const bodies: string[] = [];
  const paths: string[] = [];
  await using server = await fakeServer((asked) => {
    bodies.push(asked.body);
    paths.push(asked.url);
    return {
      json: {
        bizCode: 0,
        message: "ok",
        data: { platform: "gitlab", repository: "team/repo", branch: "feat/topic", sha: "a".repeat(40), base: "main", check: "preview", pushed: false },
      },
    };
  });
  const req = { cwd: "/external/checkout", branch: "feat/topic", sha: "a".repeat(40), base: "main", title: "Title", body: "Body", dryRun: true };
  const result = await cli([
    "repo",
    "pr",
    "submit",
    "--cwd",
    req.cwd,
    "--branch",
    req.branch,
    "--sha",
    req.sha,
    "--base",
    req.base,
    "--title",
    req.title,
    "--body",
    req.body,
    "--dry-run",
    "--format",
    "json",
    "--server",
    server.url,
  ]);
  expect(result.code).toBe(0);
  expect(paths).toEqual(["/api/v1/repo/pr/submit"]);
  const sent: unknown[] = bodies.map((body) => JSON.parse(body));
  expect(sent).toEqual([req]);
  const shown: unknown = JSON.parse(result.out);
  expect(shown).toMatchObject({ check: "preview", pushed: false });
});

it("existing branch publication is exposed only to the user", () => {
  expect(endpoints.find((e) => e.op === "repo.pr.submit")?.can).toEqual(["user"]);
});
