import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { jsonText } from "#/base/json.ts";
import { afterRealTime } from "#/infra/time.ts";

const probeMs = 10_000;

/** How the worker CLI is reached by a helper: the command it runs, and the credential file each helper's command names. */
export interface WorkerAccess extends AsyncDisposable {
  /** Whether the worker CLI starts at all; asked once. */
  readonly executableAvailable: () => Promise<boolean>;
  /** Writes id's credential (the one before it removed) and asks the CLI whether it is let in with it. */
  readonly prepare: (id: string, endpoint: string, token: string) => Promise<{ readonly authenticated: boolean; readonly command: string }>;
  readonly revoke: (id: string) => Promise<void>;
  readonly command: string;
  /** Removes the credentials' directory, and every credential in it. */
  readonly close: () => Promise<void>;
}

export interface WorkerAccessOptions {
  /** Runs the CLI and says its exit code; a test answers for it. */
  readonly exitCode?: (executable: string, args: readonly string[]) => Promise<number>;
}

/** The CLI's exit code, never a rejection; one that cannot start counts as -1, and one that does not end within probeMs (real time: it is a real process) is killed and counts as -1. */
function exitCodeOf(executable: string, args: readonly string[]): Promise<number> {
  const { promise, resolve } = Promise.withResolvers<number>();
  const child = spawn(executable, [...args], { stdio: "ignore", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  const cancel = afterRealTime(probeMs, () => {
    child.kill("SIGKILL");
    resolve(-1);
  });
  child.once("error", () => {
    cancel();
    resolve(-1);
  });
  child.once("exit", (code) => {
    cancel();
    resolve(code ?? -1);
  });
  return promise;
}

export async function workerAccess(options: WorkerAccessOptions = {}): Promise<WorkerAccess> {
  const directory = await mkdtemp(join(tmpdir(), "vibevalley-worker-"));
  await chmod(directory, 0o700);
  const source = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL(source ? "../../../../cli/src/worker.ts" : "../../cli/dist/worker.mjs", import.meta.url));
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
  const exitCode = options.exitCode ?? exitCodeOf;
  const probe = async (tail: string[]) => (await exitCode(executable, [...args, ...tail])) === 0;
  let available: Promise<boolean> | undefined;
  const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
  const command = "ELECTRON_RUN_AS_NODE=1 " + [executable, ...args].map(quote).join(" ");
  const files = new Map<string, string>();
  let generation = 0;
  const revoke = async (id: string) => {
    const file = files.get(id);
    files.delete(id);
    if (file) await rm(file, { force: true });
  };
  const prepare = async (id: string, endpoint: string, token: string) => {
    await revoke(id);
    const file = join(directory, id + "-" + ++generation + ".json");
    files.set(id, file);
    await writeFile(file, jsonText({ endpoint, token }), { mode: 0o600 });
    const authenticated = await probe(["--worker-access-file", file, "doctor"]);
    return { authenticated, command: command + " --worker-access-file " + quote(file) };
  };
  const close = async () => {
    files.clear();
    await rm(directory, { recursive: true, force: true });
  };
  return {
    executableAvailable: () => (available ??= probe(["--help"])),
    prepare,
    revoke,
    command,
    close,
    [Symbol.asyncDispose]: close,
  };
}
