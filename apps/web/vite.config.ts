import { defineConfig, lazyPlugins } from "vite-plus";
import solid from "@solidjs/vite-plugin";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Plugin } from "vite-plus";

// index.html starts on the bar public/opening.html shows (its comment says why): the part between its markers, written
// where index.html has the opening marker, so that the two cannot drift apart.
const opening = (): Plugin => ({
  name: "vibevalley-opening",
  transformIndexHtml(html) {
    const source = readFileSync(join(import.meta.dirname, "public/opening.html"), "utf8");
    const part = /<!-- opening -->([\s\S]*?)<!-- \/opening -->/.exec(source)?.[1];
    if (part === undefined || !html.includes("<!-- opening -->")) throw new Error("opening: public/opening.html and index.html each need the opening marker");
    return html.replace("<!-- opening -->", part.trim());
  },
});

// In a browser tab (vite dev) the API is the server on its usual port; served by the server, it is the same origin.
export default defineConfig({
  plugins: lazyPlugins(() => [solid(), tailwindcss(), opening()]),
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
  // The rules' tests, pure, without a DOM (the Solid plugin would give them jsdom); test/ is Playwright's.
  test: { include: ["src/**/*.test.ts"], environment: "node" },
  // test: the rules' tests; e2e (package.json) is Playwright against real servers, not cached. The build's input leaves
  // out the listing of this package's node_modules (only links into the root's .pnpm, whose files stay tracked) and
  // .vite-temp, where Vite writes its bundled config and removes it: else the cache misses whenever that folder comes
  // or goes, as on CI's fresh checkout.
  run: {
    tasks: {
      test: "vp test run",
      build: { command: "vp build", cache: { input: [{ auto: true }, "!node_modules", "!node_modules/.vite-temp/**"] } },
    },
  },
});
