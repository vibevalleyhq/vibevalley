import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { build } from "esbuild";

const desktop = join(import.meta.dirname, "..");
const out = join(desktop, "build");

await build({
  entryPoints: { main: join(desktop, "src/main.ts"), preload: join(desktop, "src/preload/preload.ts") },
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
  for (const helper of ["island", "pty"] as const) {
    try {
      execFileSync("swift", ["build", "-c", "release", "--package-path", join(desktop, "..", helper)], { stdio: "inherit" });
    } catch (e) {
      console.warn(`vibevalley: ${helper} was not built:`, e instanceof Error ? e.message : e);
    }
  }
}
