import { defineConfig } from "vite-plus";

import pkg from "./package.json" with { type: "json" };

// The tree's rules are pure; the viewer is seen through the page's stories (apps/web/test/stories.spec.ts).
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], environment: "node" },
  pack: {
    entry: Object.values(pkg.exports).flatMap((e) => (typeof e === "string" ? [] : [e.default])),
    fixedExtension: false,
    dts: { sourcemap: true, emitDtsOnly: true },
  },
  run: { tasks: { build: { command: "vp pack", cache: { input: [{ auto: true }, "!dist/**"] } }, test: "vp test run" } },
});
