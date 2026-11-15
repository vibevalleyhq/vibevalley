import { spawn, spawnSync } from "node:child_process";
import { createServer as createListener } from "node:net";
import { join } from "node:path";

import { createServer } from "vite-plus";

import { devPageEnv } from "../src/base/devPage.ts";

const desktop = join(import.meta.dirname, "..");
const web = join(desktop, "..", "web");
const repo = join(desktop, "../..");

const run = (cmd: string, args: string[], cwd: string) => {
  const done = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (done.status !== 0) process.exit(done.status ?? 1);
};

/** A free loopback port: the server is started on it, so Vite's proxy knows where /api goes before either is up. */
async function freePort(): Promise<number> {
  const probe = createListener();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("vibevalley dev: the system gave no free port");
  return address.port;
}

if (import.meta.main) {
  // The window's opening cover is apps/web/dist/opening.html, shown before the page is asked for.
  run("vp", ["run", "--filter", "@vibevalley/web", "--filter", "@vibevalley/desktop", "build"], repo);
  const serverPort = await freePort();
  // Loopback only, like the server. The page and its hot updates come from here; /api (its SSE and sockets too) goes to the server.
  const page = await createServer({
    root: web,
    server: { host: "127.0.0.1", proxy: { "/api": { target: `http://127.0.0.1:${serverPort}`, ws: true } } },
  });
  await page.listen();
  const url = page.resolvedUrls?.local[0];
  if (url === undefined) {
    await page.close();
    throw new Error("vibevalley dev: Vite's page server did not say where it listens");
  }
  const env = { ...process.env, VIBEVALLEY_DEV: "1", ...devPageEnv({ page: url, serverPort }) };
  const electron = spawn(join(desktop, "node_modules/.bin/electron"), ["."], { cwd: desktop, env, stdio: "inherit" });
  electron.on("exit", (code) => {
    void page.close().then(() => process.exit(code ?? 0));
  });
}
