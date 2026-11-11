import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

import { endpoints } from "@vibevalley/protocol/api";

import { cli } from "#/testing/testing.ts";

const json = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

it.live("repo pr submit sends the explicit checkout and dry-run to the server", () =>
  Effect.gen(function* () {
    const bodies: string[] = [];
    const paths: (string | undefined)[] = [];
    yield* HttpServer.serveEffect()(
      Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* req.text;
        bodies.push(body);
        paths.push(req.url);
        return yield* HttpServerResponse.json({
          bizCode: 0,
          message: "ok",
          data: {
            platform: "gitlab",
            repository: "team/repo",
            branch: "feat/topic",
            sha: "a".repeat(40),
            base: "main",
            check: "preview",
            pushed: false,
          },
        });
      }),
    );
    const { address } = yield* HttpServer.HttpServer;
    if (address._tag === "UnixPathAddress") return yield* Effect.die(new Error("No server address"));
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
    const sent = yield* Effect.forEach(bodies, (body) => json(body));
    expect(sent).toEqual([req]);
    const shown = yield* json(result.out);
    expect(shown).toMatchObject({ check: "preview", pushed: false });
  }).pipe(Effect.scoped, Effect.provide(NodeHttpServer.layerTest)),
);

it("existing branch publication is exposed only to the user", () => {
  expect(endpoints.find((e) => e.op === "repo.pr.submit")?.can).toEqual(["user"]);
});
