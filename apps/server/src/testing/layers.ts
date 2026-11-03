// What tests run the services on: a configuration in a temporary home and an in-memory database; and waiting in a test for
// what the farm does (the core state's transitions here, the rest re-exported from @vibevalley/testkit's).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Effect, Layer, Option, Stream } from "effect";
import { HttpClient } from "effect/http";

import { type Agent, defaultOrchestrator, type WorkspaceState } from "@vibevalley/protocol";
import { tempDir } from "@vibevalley/testkit/temp";

import { withCast } from "@/agent/agent.ts";
import { builtInDir, profileOf, templateFrom } from "@/agent/template.ts";
import { Core } from "@/core/core.ts";
import { defaults, ServerConfig } from "@/infra/config.ts";
import { Database } from "@/infra/db.ts";
import { afterRealTime } from "@/infra/time.ts";

export { aTurn, gate, nextTurn, until, untilGot, waitFor, whenTrue, within } from "@vibevalley/testkit/until";

/** A built-in template as a farm whose agent.starters names it has it: under the template's own id. */
export const starter = (id: string): Agent => {
  const textOf = (path: string) => Effect.sync(() => (existsSync(path) ? readFileSync(path, "utf8") : undefined));
  const t = Effect.runSync(templateFrom(textOf, join(builtInDir, id), "builtIn"));
  return withCast(profileOf(t, t.id, t.name));
};

/** Every built-in template's profile but the default orchestrator's, in their order: what a test farm starts with. */
const starters = () => (JSON.parse(readFileSync(join(builtInDir, "index.json"), "utf8")) as string[]).filter((id) => id !== defaultOrchestrator);

export function testConfig(change: Partial<ServerConfig["Service"]> = {}): ServerConfig["Service"] {
  const home = tempDir("vibevalley-test-");
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

const testSettings = (change: Partial<ServerConfig["Service"]> = {}) => Layer.succeed(ServerConfig, testConfig(change));

export const testDatabase = (change: Partial<ServerConfig["Service"]> = {}) => Database.pipe(Layer.provide(testSettings(change)));

/** An HTTP client for a test that must not reach the network: every request dies, so one made by mistake is a failure. */
export const offline = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make((request) => Effect.die(new Error(`no network in tests: ${request.method} ${request.url}`))),
);

/** What pick finds in the core state: in it now, or in the first state the core moves to where it finds something. It
 * waits on the core's transitions, not by asking again; the deadline is real time, as for waitFor. */
export const whenState = <A>(pick: (state: WorkspaceState) => A | undefined | false, what: string | (() => string), ms = 5_000) =>
  Effect.scoped(
    Effect.gen(function* () {
      const core = yield* Core;
      const [now, changes] = yield* core.transitions;
      const first = pick(now);
      if (first !== undefined && first !== false) return first;
      const found = Stream.runHead(
        Stream.filter(
          Stream.map(changes, (t) => pick(t.after)),
          (a): a is A => a !== undefined && a !== false,
        ),
      );
      const late = Effect.callback<Option.Option<A>>((resume) => {
        const cancel = afterRealTime(ms, () => resume(Effect.succeedNone));
        return Effect.sync(cancel);
      });
      const got = yield* Effect.raceFirst(found, late);
      if (Option.isNone(got)) return yield* Effect.die(new Error(`waited for ${typeof what === "string" ? what : what()}`));
      return got.value;
    }),
  );
