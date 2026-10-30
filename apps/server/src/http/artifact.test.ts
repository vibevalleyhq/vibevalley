import { describe, expect, it } from "@effect/vitest";
import { Context, Effect, Layer } from "effect";

import { artifactPath, ownerId } from "@vibevalley/protocol";

import { Artifacts } from "@/artifact/artifact.ts";
import { htmlPolicy } from "@/artifact/policy.ts";
import { remoteMay } from "@/lan/lan.ts";
import { testConfig } from "@/testing/layers.ts";
import { quietApp } from "@/testing/world.ts";

import { app } from "./app.ts";

const farm = Effect.gen(function* () {
  let address = "";
  const built = yield* Layer.build(app(testConfig(), 0, (a) => Effect.sync(() => void (address = a)), quietApp));
  return { address, artifacts: Context.get(built, Artifacts) };
});

describe("an artifact's content", () => {
  it.live("is read back by GET at an html version's path, sandboxed, and nothing else is: a blocks one is not a file", () =>
    Effect.gen(function* () {
      const { address, artifacts } = yield* farm;
      const owner = { from: ownerId, by: ownerId };
      // The test reads the server as a browser does, through the platform's own fetch.
      // @effect-diagnostics-next-line globalFetchInEffect:off
      const get = (path: string) => Effect.promise(() => fetch(`http://${address}${path}`));
      const html = yield* artifacts.create(owner, { title: "页", kind: "html", content: "<p>第一版</p>" });
      yield* artifacts.version(owner, { id: html.id, content: "<p>第二版</p>" });
      const first = yield* get(artifactPath(html.id, 1));
      expect([first.status, first.headers.get("content-type"), first.headers.get("content-security-policy")]).toEqual([
        200,
        "text/html; charset=utf-8",
        htmlPolicy,
      ]);
      expect([first.headers.get("x-content-type-options"), first.headers.get("cache-control")]).toEqual(["nosniff", "private, max-age=31536000, immutable"]);
      expect(yield* Effect.promise(() => first.text())).toBe("<p>第一版</p>");
      // The test reads the server as a browser does, through the platform's own fetch.
      // @effect-diagnostics-next-line globalFetchInEffect:off
      expect(yield* Effect.promise(async () => (await fetch(`http://${address}${artifactPath(html.id, 2)}`)).text())).toBe("<p>第二版</p>");
      const md = yield* artifacts.create(owner, { title: "说明", kind: "markdown", content: "# 题\n\n<script>no</script>" });
      for (const path of [
        artifactPath(md.id, 0),
        artifactPath(md.id, 1),
        artifactPath(html.id, 3),
        artifactPath(html.id, 0),
        artifactPath("0".repeat(36), 1),
        "/api/v1/artifact/../vibevalley.yaml",
        `/api/v1/artifact/${html.id}/1x`,
      ])
        expect([path, (yield* get(path)).status]).toEqual([path, 404]);
    }).pipe(Effect.scoped),
  );

  it("is open to a paired device like an attachment, and /mcp still is not", () => {
    expect(remoteMay("GET", artifactPath("01a18349-6451-7525-a49b-7a57810204fb", 2))).toBe(true);
    expect(remoteMay("POST", artifactPath("01a18349-6451-7525-a49b-7a57810204fb", 2))).toBe(false);
    expect(remoteMay("POST", "/api/v1/artifact/list")).toBe(true);
    expect(remoteMay("POST", "/mcp")).toBe(false);
  });
});
