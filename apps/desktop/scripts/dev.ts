import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

const desktop = join(import.meta.dirname, "..");
const web = join(desktop, "..", "web");

const run = (cmd: string, args: string[], cwd: string) => {
  const done = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (done.status !== 0) process.exit(done.status ?? 1);
};

run("pnpm", ["exec", "vpx", "scripts/build.ts"], desktop);
run("pnpm", ["exec", "vp", "build"], web);
const watcher = spawn("pnpm", ["exec", "vp", "build", "--watch"], { cwd: web, stdio: ["ignore", "inherit", "inherit"] });
const electron = spawn("pnpm", ["exec", "electron", "."], { cwd: desktop, env: { ...process.env, VIBEVALLEY_DEV: "1" }, stdio: "inherit" });
electron.on("exit", (code) => {
  watcher.kill();
  process.exit(code ?? 0);
});
