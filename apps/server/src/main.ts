// The vibevalley server: the farm over HTTP on loopback. The desktop app starts it on a free
// port and reads where from --ready-json; run alone, it is the server.
//
//	node --import tsx src/main.ts                        # port from the configuration (127.0.0.1:8787)
//	node --import tsx src/main.ts --config dev.yaml      # this file, not $VIBEVALLEY_HOME/vibevalley.yaml
//	node --import tsx src/main.ts --web ../web/dist      # also the React page at /
//
// The configuration is loadConfig's: the YAML file, then VIBEVALLEY_* in the environment.

import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
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

const loaded = loadConfig(flags.config);
const config = flags.web ? { ...loaded, web: flags.web } : loaded;

const farm = app(config, config.port, (address) =>
  Effect.gen(function* () {
    yield* Effect.log(`vibevalley: listening on http://${address}`);
    if (flags["ready-json"]) process.stdout.write(JSON.stringify({ url: `http://${address}`, pid: process.pid }) + "\n");
  }),
);

mkdirSync(config.home, { recursive: true });
mkdirSync(projectsDir(config), { recursive: true });
const release = leaseHome(config.home);
process.on("exit", release);
NodeRuntime.runMain(Layer.launch(farm));
