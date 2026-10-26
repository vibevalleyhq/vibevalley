import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export interface VerificationResult {
  code: number;
  evidence: string;
  address: string;
}

function isolatedEnvironment(home: string, work: string): Record<string, string> {
  const env: Record<string, string> = {};
  const screenOptions = new Set(["VIBEVALLEY_PAGES", "VIBEVALLEY_SCREEN"]);
  for (const [key, value] of Object.entries(process.env)) {
    if (
      value !== undefined &&
      (!key.startsWith("VIBEVALLEY_") || screenOptions.has(key)) &&
      !["DEEPSEEK_API_KEY", "AGORA_APP_ID", "AGORA_APP_CERTIFICATE"].includes(key)
    )
      env[key] = value;
  }
  return {
    ...env,
    VIBEVALLEY_HOME: home,
    VIBEVALLEY_WORK_ROOT: work,
    VIBEVALLEY_PORT: "0",
    VIBEVALLEY_VOICE_LINE_PORT: "0",
    VIBEVALLEY_PATROL_HEARTBEAT_MINUTES: "0",
  };
}

// The child publishes this protocol.ServerReady receipt after binding its own port.
export function readyAddress(line: string, pid: number): string | undefined {
  try {
    const ready = JSON.parse(line);
    if (ready.pid !== pid || typeof ready.url !== "string") return;
    const url = new URL(ready.url);
    if (url.protocol === "http:" && url.hostname === "127.0.0.1" && Number(url.port) > 0) return url.origin;
  } catch {
    /* Other stdout is still logged, but is not a readiness receipt. */
  }
}

// The validation command owns assertions and fixtures; this owner isolates and releases its server and child process groups.
export interface VerificationOptions {
  /** pi is the scripted helper the server's tests hire (apps/server/src/testing/helper.ts), doing what the words of its
   * job say, and no other runtime is installed: issues can be sent and handed back without a key or a real agent. */
  readonly scriptedHelper?: boolean;
}

export async function runVerification(command: string[] = [], options: VerificationOptions = {}): Promise<VerificationResult> {
  if (process.platform === "win32") throw new Error("verification sandbox requires Unix process groups");
  const root = resolve(import.meta.dirname, "..");
  const evidence = mkdtempSync(join(tmpdir(), "vibevalley-verify-"));
  const home = join(evidence, "home");
  const work = join(evidence, "work");
  const binaries = join(evidence, "bin");
  for (const path of [home, work, binaries]) mkdirSync(path);
  const env: Record<string, string> = { ...isolatedEnvironment(home, work), ...(options.scriptedHelper ? { VIBEVALLEY_TEST_RUNTIMES: "1" } : {}) };
  const serverDir = join(root, "apps", "server");
  // The command line from any folder: tsx is the server's own.
  const cli = join(binaries, "vv");
  writeFileSync(
    cli,
    `#!/bin/sh\nexec ${JSON.stringify(join(serverDir, "node_modules", ".bin", "tsx"))} ${JSON.stringify(join(serverDir, "src", "cli.ts"))} "$@"\n`,
    { mode: 0o755 },
  );
  const log = join(evidence, "server.stdout.log");
  /** A child in a process group of its own; exited settles with its exit code. */
  interface Child {
    pid: number;
    exited: Promise<number>;
    exitCode: () => number | null;
    process: ChildProcess;
  }
  const own = (p: ChildProcess): Child => {
    const exited = new Promise<number>((done) => p.once("exit", (status, sig) => done(status ?? (sig ? 128 : 1))));
    return { pid: p.pid!, exited, exitCode: () => p.exitCode, process: p };
  };
  const owned = new Set<Child>();
  let serverOutputDone: Promise<void> | undefined;
  let outputFailure: unknown;
  let interrupted = false;
  let address = "";
  let code = 1;
  const signal = (child: Child, signal: "SIGTERM" | "SIGKILL") => {
    try {
      process.kill(-child.pid, signal);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
      if ((error as NodeJS.ErrnoException).code === "EPERM") return false;
      throw error;
    }
  };
  const alive = (child: Child) => {
    try {
      process.kill(-child.pid, 0);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
      if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
      throw error;
    }
  };
  const interrupt = () => {
    interrupted = true;
    for (const child of owned) signal(child, "SIGTERM");
  };
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);
  const launch = (args: string[], cwd: string, name: string, environment = env): Child => {
    const out = openSync(join(evidence, name + ".stdout.log"), "w");
    const err = openSync(join(evidence, name + ".stderr.log"), "w");
    const child = own(spawn(args[0]!, args.slice(1), { cwd, env: environment, detached: true, stdio: ["ignore", out, err] }));
    closeSync(out);
    closeSync(err);
    owned.add(child);
    return child;
  };
  const stop = async (child: Child) => {
    signal(child, "SIGTERM");
    const deadline = Date.now() + 30_000;
    while (alive(child) && Date.now() < deadline) await sleep(50);
    if (alive(child) && !signal(child, "SIGKILL")) throw new Error(`cannot stop owned process group ${child.pid}`);
    await child.exited;
    owned.delete(child);
  };
  try {
    if (interrupted) throw new Error("verification interrupted before startup");
    // node itself, so the receipt's pid is the child's; it logs to stdout.
    // The built page, when there is one, so acceptance can screenshot it on the same server.
    const web = join(root, "apps", "web", "dist");
    const serverErr = openSync(join(evidence, "server.stderr.log"), "w");
    const spawned = spawn("node", ["--import", "tsx", "src/main.ts", "--ready-json", ...(existsSync(join(web, "index.html")) ? ["--web", web] : [])], {
      cwd: serverDir,
      env,
      detached: true,
      stdio: ["ignore", "pipe", serverErr],
    });
    closeSync(serverErr);
    const running = own(spawned);
    owned.add(running);
    serverOutputDone = (async () => {
      const output = createWriteStream(join(evidence, "server.stdout.log"));
      const decoder = new TextDecoder();
      let pending = "";
      try {
        for await (const chunk of spawned.stdout! as AsyncIterable<Buffer>) {
          output.write(chunk);
          pending += decoder.decode(chunk, { stream: true });
          let end: number;
          while ((end = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, end);
            pending = pending.slice(end + 1);
            const announced = readyAddress(line, running.pid);
            if (!address && announced) {
              address = announced;
              writeFileSync(join(evidence, "ready.json"), line + "\n");
            }
          }
        }
      } finally {
        await new Promise<void>((done) => output.end(done));
      }
    })().catch((error) => {
      outputFailure = error;
    });
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      if (interrupted) throw new Error("verification interrupted during startup");
      if (running.exitCode() !== null) throw new Error(`server exited ${running.exitCode()}; see ${log}`);
      if (outputFailure) throw new Error(`server output failed: ${outputFailure instanceof Error ? outputFailure.message : String(outputFailure as string)}`);
      if (address) {
        try {
          const response = await fetch(address + "/api/v1/health", { signal: AbortSignal.timeout(1_000) });
          if (response.ok) {
            const health = await response.json();
            if (health.ok === true) {
              writeFileSync(join(evidence, "health.json"), JSON.stringify(health, null, 2));
              break;
            }
          }
        } catch {
          /* Retry a transient health failure within the startup deadline. */
        }
      }
      await sleep(100);
    }
    if (!address || !existsSync(join(evidence, "health.json"))) throw new Error(`server did not become healthy; see ${log}`);
    const run = command.length ? command : [cli, "server", "health"];
    const task = launch(run, root, "command", { ...env, VIBEVALLEY_SERVER: address, VIBEVALLEY_VERIFY_CLI: cli });
    code = await task.exited;
    if (interrupted) code = 130;
    return { code, evidence, address };
  } catch (error) {
    writeFileSync(join(evidence, "failure.txt"), String(error));
    throw new Error(`${String(error)}\nevidence: ${evidence}`);
  } finally {
    const failures: unknown[] = [];
    for (const child of [...owned].reverse()) {
      try {
        await stop(child);
      } catch (error) {
        failures.push(error);
      }
    }
    await serverOutputDone;
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    writeFileSync(
      join(evidence, "result.json"),
      JSON.stringify({ code, address, stopped: failures.length === 0, command: command[0] ?? "server health", cleanupErrors: failures.map(String) }, null, 2),
    );
    if (failures.length === 0) for (const path of [home, work, binaries]) rmSync(path, { recursive: true, force: true });
    console.log(`verification evidence: ${evidence}`);
    // oxlint-disable-next-line no-unsafe-finally -- a cleanup failure outranks the run's own: its data is kept to look at.
    if (failures.length) throw new AggregateError(failures, "verification cleanup failed; temporary data preserved");
  }
}

if (import.meta.main) {
  let args = process.argv.slice(2);
  const scriptedHelper = args[0] === "--scripted-helper";
  if (scriptedHelper) args = args.slice(1);
  if (args[0] === "--help") {
    console.log("usage: bun scripts/verify-server.ts [--scripted-helper] [-- command args...]");
  } else {
    try {
      process.exitCode = (await runVerification(args[0] === "--" ? args.slice(1) : args, { scriptedHelper })).code;
    } catch (error) {
      console.error(String(error));
      process.exitCode = 1;
    }
  }
}
