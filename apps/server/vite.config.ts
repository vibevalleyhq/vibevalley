import { defineConfig } from "vite-plus";
import { configDefaults } from "vite-plus/test/config";

// Tests run real git and a database in every file at once: a slow machine under that load needs more than 5 s.
export default defineConfig({
  // isolate: false loads the modules once per worker, not once per file (a fifth of the run), and lets Database keep its emptied in-memory databases across files.
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 20_000,
    // Each farm runs its own Postgres (PGlite, in WASM): a worker on every core leaves the heaviest tests (media's
    // disk-backed audio) waiting for CPU past their timeout, and half as many finish the run as soon.
    maxWorkers: "50%",
    env: { TZ: "Asia/Shanghai" },
    isolate: false,
    reporters: [...configDefaults.reporters, "@vibevalley/testkit/budgets"],
  },
  // The packaged app's server and its terminal conversations (apps/desktop/scripts/package.ts).
  pack: {
    entry: { main: "src/main.ts", chat: "src/chat/main.ts" },
    target: "node24",
    dts: false,
    deps: { alwaysBundle: [/^@vibevalley\//u] },
  },
  // The cache sees the files a run reads but not its environment: these change what the tests do.
  run: {
    tasks: {
      test: {
        command: "vp test run",
        cache: { env: ["VIBEVALLEY_EVALS_LIVE", "VIBEVALLEY_EVAL_N", "VIBEVALLEY_EVAL_MODEL", "VIBEVALLEY_EVALS"] },
      },
    },
  },
});
