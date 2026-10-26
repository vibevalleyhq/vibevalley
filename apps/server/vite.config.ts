import { defineConfig } from "vite-plus";
import { configDefaults } from "vite-plus/test/config";

// Tests run real git and a database in every file at once: a slow machine under that load needs more than 5 s.
// The rules read the owner's local clock (reset times, night and weekend achievements) and the golden data was
// recorded at UTC+8: every machine, CI included, runs the tests there.
export default defineConfig({
  // isolate: false loads the modules once per worker, not once per file (a fifth of the run), and lets Database keep
  // its emptied in-memory databases across files. It holds because no test leans on another's module state; files and
  // tests in shuffled order pass the same (vp test run --sequence.shuffle).
  // The default reporters (the agent's, CI's annotations) stay; budgets.ts adds the tests over their layer's budget.
  test: {
    include: ["src/**/*.test.ts"],
    testTimeout: 20_000,
    env: { TZ: "Asia/Shanghai" },
    isolate: false,
    reporters: [...configDefaults.reporters, "./src/testing/budgets.ts"],
  },
  // The cache sees the files a run reads but not its environment: these change what the tests do (golden.ts writes the
  // golden data on update; the live evals run on the real model), so a run with them set never replays one without.
  // DEEPSEEK_API_KEY stays out: a key is not fingerprinted, and the live evals are a script (vp run evals), not this task.
  run: {
    tasks: {
      test: {
        command: "vp test run",
        cache: { env: ["VIBEVALLEY_GOLDEN", "VIBEVALLEY_EVALS_LIVE", "VIBEVALLEY_EVAL_N", "VIBEVALLEY_EVAL_MODEL", "VIBEVALLEY_EVALS"] },
      },
    },
  },
});
