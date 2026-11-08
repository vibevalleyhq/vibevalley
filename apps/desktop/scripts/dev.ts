import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

import { build, type Rolldown } from "vite-plus";

const desktop = join(import.meta.dirname, "..");
const web = join(desktop, "..", "web");

const run = (cmd: string, args: string[], cwd: string) => {
  const done = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (done.status !== 0) process.exit(done.status ?? 1);
};

export function firstBuild(watcher: {
  on(event: "event", listener: (event: Rolldown.RolldownWatcherEvent) => void): void;
  off(event: "event", listener: (event: Rolldown.RolldownWatcherEvent) => void): void;
}): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const built = (event: Rolldown.RolldownWatcherEvent) => {
    if (event.code !== "END" && event.code !== "ERROR") return;
    watcher.off("event", built);
    if (event.code === "ERROR") reject(event.error);
    else resolve();
  };
  watcher.on("event", built);
  return promise;
}

if (import.meta.main) {
  run("pnpm", ["exec", "vpx", "scripts/build.ts"], desktop);
  const env = { ...process.env, VIBEVALLEY_DEV: "1" };
  const watcher = await build({ root: web, build: { watch: {} } });
  if (!("on" in watcher)) throw new Error("vibevalley dev: the web build did not start a watcher");
  try {
    // The watcher's initial build must finish before Electron can watch dist for later changes.
    await firstBuild(watcher);
  } catch (error) {
    await watcher.close();
    throw error;
  }
  const electron = spawn("pnpm", ["exec", "electron", "."], { cwd: desktop, env, stdio: "inherit" });
  electron.on("exit", (code) => {
    void watcher.close().then(() => process.exit(code ?? 0));
  });
}
