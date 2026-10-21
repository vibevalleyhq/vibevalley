// Builds what `electron .` runs from apps/desktop/build: the main process and the preload (CommonJS, as Electron's sandboxed
// preload needs). The page is apps/web/dist (pnpm --filter vibevalley-web run build); the server runs from apps/server
// (src/server.ts).

import { build } from "esbuild";
import { join } from "node:path";

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
