import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";

import { announce } from "@vibevalley/home";
import type { ServerReady } from "@vibevalley/protocol";

import { app } from "#/gateway/http/app.ts";

import { messageOf } from "./base/errors.ts";
import { redactOutput } from "./base/redact.ts";
import { loadConfig, pkmDir, reposDir, worktreesDir } from "./infra/config.ts";
import { HomeTaken, HomeUnavailable, leaseHome } from "./infra/lease.ts";
import { makeLogger } from "./infra/log.ts";
import type { ServiceOptions } from "./services.ts";

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

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const log = makeLogger({ name: "vibevalley" });

// The page's tests (apps/web/test/fixtures.ts) never ask this machine's coding agents, nor the network. Never set otherwise.
async function testOptions(): Promise<ServiceOptions> {
  const { helper, installedOnly } = await import("./testing/worker.ts");
  const { registryOf } = await import("#/modules/runtime/runtime.ts");
  const { realtimeFixture } = await import("./testing/realtime.ts");
  const { network } = await import("./testing/network.ts");
  const given = [helper()];
  return {
    runtime: { registry: registryOf(given), probe: installedOnly(given), background: false },
    voice: { moss: realtimeFixture },
    platform: { ...network(), log },
  };
}

/** The home, taken until it stops: a second server on it is refused. */
function lease(home: string): () => void {
  try {
    return leaseHome(home);
  } catch (cause) {
    if (cause instanceof HomeTaken) throw cause;
    throw new HomeUnavailable(messageOf(cause), { cause });
  }
}

async function main(): Promise<() => Promise<void>> {
  const testRuntimesAsked = process.env["VIBEVALLEY_TEST_RUNTIMES"] === "1";
  const loaded = await loadConfig(flags.config);
  const config = flags.web ? { ...loaded, web: flags.web } : loaded;
  const options: ServiceOptions = testRuntimesAsked ? await testOptions() : { platform: { log } };
  await mkdir(config.home, { recursive: true });
  const repos = reposDir(config);
  const notes = pkmDir(config);
  const oldRepos = join(config.workRoot, "projects");
  const oldNotes = join(config.home, "pkm");
  if ((await exists(oldRepos)) && !(await exists(repos))) log.warn(`vibevalley: ${oldRepos} is no longer read; move its repositories into ${repos}`);
  if (config.pkm.root === "" && (await exists(oldNotes)) && !(await exists(notes)))
    log.warn(`vibevalley: ${oldNotes} is no longer read; move its notes into ${notes}`);
  await mkdir(repos, { recursive: true });
  await mkdir(worktreesDir(config), { recursive: true });
  await mkdir(notes, { recursive: true });
  const release = lease(config.home);
  // Said once it listens, taken back when it stops.
  let withdraw = () => {};
  try {
    const served = await app(
      config,
      config.port,
      (address) => {
        log.info(`vibevalley: listening on http://${address}`);
        withdraw = announce(config.home, `http://${address}`);
        if (flags["ready-json"]) process.stdout.write(JSON.stringify({ url: `http://${address}`, pid: process.pid } satisfies ServerReady) + "\n");
      },
      options,
    );
    return async () => {
      try {
        await served.close();
      } finally {
        withdraw();
        release();
      }
    };
  } catch (e) {
    withdraw();
    release();
    throw e;
  }
}

// It runs until a signal: the farm closes (every service, the database last), the home is given back, then it exits.
try {
  const stop = await main();
  let stopping = false;
  const onSignal = () => {
    if (stopping) return;
    stopping = true;
    stop().then(
      () => process.exit(0),
      (e: unknown) => {
        log.error("vibevalley: did not stop cleanly", e);
        process.exit(1);
      },
    );
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
} catch (e) {
  log.error(e);
  process.exit(1);
}
