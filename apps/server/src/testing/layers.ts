// What tests run the services on: a configuration in a temporary home and an in-memory database.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Agent, defaultOrchestrator } from "@vibevalley/protocol";
import { Effect, Layer } from "effect";
import { HttpClient } from "effect/http";
import { withCast } from "@/agent/agent.ts";
import { builtInDir, builtInIds, profileOf, readTemplate } from "@/agent/template.ts";
import { defaults, ServerConfig } from "@/base/config.ts";
import { Database } from "@/base/db.ts";

/** A built-in template as a farm whose agent.starters names it has it: under the template's own id. */
export const starter = (id: string): Agent => {
  const t = readTemplate(join(builtInDir, id), "builtIn");
  return withCast(profileOf(t, t.id, t.name));
};

/** Every built-in template's profile but the default orchestrator's, in their order: what a test farm starts with. */
const starters = () => builtInIds().filter((id) => id !== defaultOrchestrator);

export function testConfig(change: Partial<ServerConfig["Service"]> = {}): ServerConfig["Service"] {
  const home = mkdtempSync(join(tmpdir(), "vibevalley-test-"));
  const config = defaults(home);
  // Every listener on a free port: two farms in tests (or worktrees) never take each other's 8787, 8788, 8790.
  return {
    ...config,
    home,
    workRoot: join(home, "work"),
    db: "memory",
    port: 0,
    voice: { ...config.voice, line: { ...config.voice.line, port: 0 } },
    lan: { ...config.lan, port: 0 },
    agent: { ...config.agent, starters: starters() },
    ...change,
  };
}

export const testSettings = (change: Partial<ServerConfig["Service"]> = {}) => Layer.succeed(ServerConfig, testConfig(change));

export const testDatabase = (change: Partial<ServerConfig["Service"]> = {}) => Database.pipe(Layer.provide(testSettings(change)));

/** An HTTP client for a test that must not reach the network: every request dies, so one made by mistake is a failure. */
export const offline = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => Effect.die(new Error(`no network in tests: ${request.method} ${request.url}`))),
);
