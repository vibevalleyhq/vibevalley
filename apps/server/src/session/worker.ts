import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Context, Effect, FileSystem } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

export const workerAccess = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "vibevalley-worker-" });
  yield* fs.chmod(directory, 0o700);
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const source = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL(source ? "../../../cli/src/worker.ts" : "../../cli/dist/worker.mjs", import.meta.url));
  const args = source
    ? [
        "--require",
        fileURLToPath(new URL("script-preload.cjs", import.meta.resolve("vite-plus"))),
        "--import",
        new URL("script-register.js", import.meta.resolve("vite-plus")).href,
        entry,
      ]
    : [entry];
  const executable = process.execPath;
  const probe = (tail: string[]) =>
    spawner.exitCode(ChildProcess.make(executable, [...args, ...tail], { stdin: "ignore", env: { ELECTRON_RUN_AS_NODE: "1" } })).pipe(
      Effect.map((code) => code === 0),
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => false),
    );
  const executableAvailable = yield* Effect.cached(probe(["--help"]));
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = "ELECTRON_RUN_AS_NODE=1 " + [executable, ...args].map(quote).join(" ");
  const files = new Map<string, string>();
  let generation = 0;
  const revoke = Effect.fnUntraced(function* (id: string) {
    const file = files.get(id);
    files.delete(id);
    if (file) yield* fs.remove(file, { force: true });
  });
  const prepare = Effect.fnUntraced(function* (id: string, endpoint: string, token: string) {
    yield* revoke(id);
    const file = join(directory, id + "-" + ++generation + ".json");
    files.set(id, file);
    yield* fs.writeFileString(file, JSON.stringify({ endpoint, token }), { mode: 0o600 });
    const authenticated = yield* probe(["--worker-access-file", file, "doctor"]);
    return { authenticated, command: command + " --worker-access-file " + quote(file) };
  });
  return { executableAvailable, prepare, revoke, command };
});

export const WorkerAccess = Context.Reference<typeof workerAccess>("vibevalley/WorkerAccess", { defaultValue: () => workerAccess });
