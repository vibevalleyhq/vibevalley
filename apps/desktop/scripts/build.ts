// Builds what `electron .` runs from apps/desktop/build: the main process and the preload (CommonJS, as Electron's sandboxed
// preload needs). The page is apps/web/dist (vp run --filter @vibevalley/web build); the server runs from apps/server
// (src/server.ts). On macOS it builds the island too (apps/island, release), where src/main.ts looks for it.

import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { build } from "esbuild";

const desktop = join(import.meta.dirname, "..");
const out = join(desktop, "build");

await build({
  entryPoints: { main: join(desktop, "src/main.ts"), preload: join(desktop, "src/preload.ts") },
  outdir: out,
  outExtension: { ".js": ".cjs" },
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  external: ["electron"],
  logLevel: "warning",
});

if (process.platform === "darwin") {
  try {
    execFileSync("swift", ["build", "-c", "release", "--package-path", join(desktop, "../island")], { stdio: "inherit" });
  } catch (e) {
    // Without Swift (or with a broken build) the app still runs, without the island.
    console.warn("vibevalley: the island was not built:", e instanceof Error ? e.message : e);
  }
}
