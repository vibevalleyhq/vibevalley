import { type ChildProcess, spawn, spawnSync } from "node:child_process";

export type { ChildProcess as VdpChildProcess };

function errorCode(err: unknown): string | undefined {
  if (typeof err !== "object" || err === null || !("code" in err)) return undefined;
  const code = (err as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function runChecked(
  command: string,
  args: readonly string[],
  options: { readonly cwd: string; readonly env?: NodeJS.ProcessEnv; readonly capture?: boolean; readonly timeoutMs?: number },
): string {
  const res = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.capture === true ? ["ignore", "pipe", "pipe"] : "inherit",
    timeout: options.timeoutMs ?? 60_000,
  });
  if (res.error) {
    throw new Error(`${command} ${args.join(" ")} failed to spawn: ${res.error.message}`, { cause: res.error });
  }
  if (res.status !== 0) {
    const stdout = typeof res.stdout === "string" ? res.stdout.trim() : "";
    const stderr = typeof res.stderr === "string" ? res.stderr.trim() : "";
    const detail = [stdout, stderr].filter(Boolean).join("\n");
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${String(res.status)}${detail ? `:\n${detail}` : ""}`);
  }
  return typeof res.stdout === "string" ? res.stdout : "";
}

export function runFfmpeg(args: readonly string[], timeoutMs = 30_000): boolean {
  const res = spawnSync("ffmpeg", args, { stdio: "ignore", timeout: timeoutMs });
  return !res.error && res.status === 0;
}

export function spawnDetachedMac(binPath: string, cwd: string, env: Record<string, string>, logFd: number): ChildProcess {
  return spawn(binPath, [], {
    cwd,
    env,
    detached: true,
    stdio: ["ignore", logFd, logFd],
  });
}

export function signalProcessGroup(pid: number | undefined, sig: "SIGTERM" | "SIGKILL"): boolean {
  if (pid === undefined) return true;
  try {
    process.kill(-pid, sig);
    return true;
  } catch (err) {
    if (errorCode(err) === "ESRCH") return true;
    if (errorCode(err) === "EPERM") return false;
    throw err;
  }
}

export function processGroupAlive(pid: number | undefined): boolean {
  if (pid === undefined) return false;
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    if (errorCode(err) === "ESRCH") return false;
    if (errorCode(err) === "EPERM") return true;
    throw err;
  }
}
