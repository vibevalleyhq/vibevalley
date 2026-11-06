import { createServer } from "node:http";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { endpoints } from "@vibevalley/protocol/api";

import { cli } from "./testing.ts";

it.live("repo pr submit sends the explicit checkout and dry-run to the server", () =>
  Effect.gen(function* () {
    const bodies: string[] = [];
    const paths: (string | undefined)[] = [];
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => {
        body += chunk;
      });
      req.on("end", () => {
        bodies.push(body);
        paths.push(req.url);
        res.setHeader("Content-Type", "application/json");
        res.end(
          JSON.stringify({
            platform: "gitlab",
            repository: "team/repo",
            branch: "feat/topic",
            sha: "a".repeat(40),
            base: "main",
            check: "preview",
            pushed: false,
          }),
        );
      });
    });
    yield* Effect.acquireRelease(
      Effect.promise<void>(() => new Promise((resolve) => server.listen(0, "127.0.0.1", resolve))),
      () => Effect.sync(() => server.close()),
    );
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No server address");
    const req = { cwd: "/external/checkout", branch: "feat/topic", sha: "a".repeat(40), base: "main", title: "Title", body: "Body", dryRun: true };
    const result = yield* cli([
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
      `http://127.0.0.1:${address.port}`,
    ]);
    expect(result.code).toBe(0);
    expect(paths).toEqual(["/api/v1/repo/pr/submit"]);
    expect(bodies.map((body) => JSON.parse(body))).toEqual([req]);
    expect(JSON.parse(result.out)).toMatchObject({ check: "preview", pushed: false });
  }).pipe(Effect.scoped),
);

it("existing branch publication is exposed only to the owner", () => {
  expect(endpoints.find((e) => e.op === "repo.pr.submit")?.can).toEqual(["owner"]);
});
