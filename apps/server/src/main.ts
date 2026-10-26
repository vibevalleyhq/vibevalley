// The vibevalley server: the farm over HTTP on loopback. The desktop app starts it on a free
// port and reads where from --ready-json; run alone, it is the server.
//
//	node --import tsx src/main.ts                        # port from the configuration (127.0.0.1:8787)
//	node --import tsx src/main.ts --config dev.yaml      # this file, not $VIBEVALLEY_HOME/vibevalley.yaml
//	node --import tsx src/main.ts --web ../web/dist      # also the page at /
//
// The configuration is loadConfig's: the YAML file, then VIBEVALLEY_* in the environment.

import { parseArgs } from "node:util";
import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Effect, FileSystem, Layer } from "effect";
import { FetchHttpClient } from "effect/http";
import { Otlp, OtlpSerialization } from "effect/observability";
import { loadConfig, projectsDir } from "./base/config.ts";
import { leaseHome } from "./base/lease.ts";
import { redactOutput } from "./base/redact.ts";
import { app } from "./http/app.ts";

const { values: flags } = parseArgs({
  options: {
    config: { type: "string", default: "" },
    "ready-json": { type: "boolean", default: false },
    web: { type: "string", default: "" },
  },
});

// The ready line goes through it too: it holds only the address and the pid.
redactOutput(process.stdout);
redactOutput(process.stderr);

// The page's tests (apps/web/test/fixtures.ts) never ask this machine's coding agents: pi is the scripted helper the
// server's tests hire, and it is the only runtime installed. Never set otherwise; loaded only then.
const testRuntimes = async () => {
  const [{ helper, installedOnly }, { registryOf }] = await Promise.all([import("./testing/helper.ts"), import("./runtime/runtime.ts")]);
  const given = [helper()];
  return { registry: registryOf(given), probe: installedOnly(given), background: false };
};

const main = Effect.gen(function* () {
  const loaded = yield* loadConfig(flags.config);
  const config = flags.web ? { ...loaded, web: flags.web } : loaded;
  const runtime = process.env.VIBEVALLEY_TEST_RUNTIMES === "1" ? yield* Effect.promise(testRuntimes) : undefined;
  const fs = yield* FileSystem.FileSystem;
  yield* fs.makeDirectory(config.home, { recursive: true });
  yield* fs.makeDirectory(projectsDir(config), { recursive: true });
  // The home is this server's until it stops.
  yield* Effect.acquireRelease(
    Effect.try(() => leaseHome(config.home)),
    (release) => Effect.sync(release),
  );
  const farm = app(
    config,
    config.port,
    (address) =>
      Effect.gen(function* () {
        yield* Effect.log(`vibevalley: listening on http://${address}`);
        if (flags["ready-json"]) process.stdout.write(JSON.stringify({ url: `http://${address}`, pid: process.pid }) + "\n");
      }),
    { runtime },
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
  return yield* Layer.launch(observed);
});

NodeRuntime.runMain(main.pipe(Effect.scoped, Effect.provide(NodeServices.layer)));
