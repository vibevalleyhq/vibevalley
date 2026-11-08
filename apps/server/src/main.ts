import { join } from "node:path";
import { parseArgs } from "node:util";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Otlp, OtlpSerialization } from "effect/observability";

import { announce } from "@vibevalley/home";
import type { ServerReady } from "@vibevalley/protocol";

import { redactOutput } from "./base/redact.ts";
import { app } from "./http/app.ts";
import { loadConfig, pkmDir, reposDir, worktreesDir } from "./infra/config.ts";
import { leaseHome } from "./infra/lease.ts";
import { PublicHttp } from "./infra/publicHttp.ts";

const { values: flags } = parseArgs({
  options: {
    config: { type: "string", default: "" },
    "ready-json": { type: "boolean", default: false },
    web: { type: "string", default: "" },
  },
});

// Read here, at the process's door, with the flags: the Effect code below is handed what it says.
const testRuntimesAsked = process.env.VIBEVALLEY_TEST_RUNTIMES === "1";

// The ready line goes through it too: it holds only the address and the pid.
redactOutput(process.stdout);
redactOutput(process.stderr);

// The page's tests (apps/web/test/fixtures.ts) never ask this machine's coding agents. Never set otherwise.
const testRuntimes = Effect.gen(function* () {
  const { helper, installedOnly } = yield* Effect.promise(() => import("./testing/worker.ts"));
  const { registryOf } = yield* Effect.promise(() => import("./runtime/runtime.ts"));
  const given = [helper()];
  return { registry: registryOf(given), probe: installedOnly(given), background: false };
});

const main = Effect.gen(function* () {
  const loaded = yield* loadConfig(flags.config);
  const config = flags.web ? { ...loaded, web: flags.web } : loaded;
  const runtime = testRuntimesAsked ? yield* testRuntimes : undefined;
  const network = testRuntimesAsked
    ? (yield* Effect.promise(() => import("./testing/network.ts"))).network
    : Layer.merge(FetchHttpClient.layer, PublicHttp.layer);
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(config.home, { recursive: true });
  const repos = reposDir(config);
  const notes = pkmDir(config);
  const oldRepos = join(config.workRoot, "projects");
  const oldNotes = join(config.home, "pkm");
  if ((yield* fs.exists(oldRepos)) && !(yield* fs.exists(repos)))
    yield* Effect.logWarning(`vibevalley: ${oldRepos} is no longer read; move its repositories into ${repos}`);
  if (config.pkm.root === "" && (yield* fs.exists(oldNotes)) && !(yield* fs.exists(notes)))
    yield* Effect.logWarning(`vibevalley: ${oldNotes} is no longer read; move its notes into ${notes}`);
  yield* fs.makeDirectory(repos, { recursive: true });
  yield* fs.makeDirectory(worktreesDir(config), { recursive: true });
  yield* fs.makeDirectory(notes, { recursive: true });
  // The home is this server's until it stops.
  yield* Effect.acquireRelease(
    Effect.try(() => leaseHome(config.home)),
    (release) => Effect.sync(release),
  );
  // Said once it listens, taken back when it stops.
  let withdraw = () => {};
  yield* Effect.addFinalizer(() => Effect.sync(() => withdraw()));
  const farm = app(
    config,
    config.port,
    (address) =>
      Effect.gen(function* () {
        yield* Effect.log(`vibevalley: listening on http://${address}`);
        withdraw = announce(config.home, `http://${address}`);
        if (flags["ready-json"]) process.stdout.write(JSON.stringify({ url: `http://${address}`, pid: process.pid } satisfies ServerReady) + "\n");
      }),
    runtime ? { runtime } : {},
  );
  // With otlp.url the services' spans (Effect.fn), logs and metrics go to that collector; without it nothing is sent.
  const observed = config.otlp.url
    ? farm.pipe(
        Layer.provide(
          Otlp.layer({ baseUrl: config.otlp.url, resource: { serviceName: "vibevalley", serviceVersion: config.version } }).pipe(
            Layer.provide([FetchHttpClient.layer, OtlpSerialization.layerJson]),
          ),
        ),
      )
    : farm;
  return yield* Layer.launch(observed.pipe(Layer.provide(network)));
});

NodeRuntime.runMain(main.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
