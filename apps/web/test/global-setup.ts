// A folder of this run's own: two runs at once do not share one.
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const web = join(import.meta.dirname, "..");

export default function setup() {
  const out = join(web, ".test", `run-${process.pid}`);
  process.env.VIBEVALLEY_TEST_OUT = out;
  // VIBEVALLEY_WEB_DEV=1: Solid's development build, whose diagnostics (a read that goes untracked, a write inside a
  // computation…) the page fixture collects (fixtures.ts).
  const dev = process.env.VIBEVALLEY_WEB_DEV === "1";
  execFileSync(
    "pnpm",
    [
      "exec",
      "vp",
      "build",
      ...(dev ? ["--mode", "development", "--minify", "false"] : []),
      "--outDir",
      join(out, "dist"),
      "--emptyOutDir",
      "--logLevel",
      "warn",
    ],
    {
      cwd: web,
      stdio: "inherit",
      env: dev ? { ...process.env, NODE_ENV: "development" } : process.env,
    },
  );
  execFileSync(
    "pnpm",
    [
      "exec",
      "vp",
      "build",
      "--config",
      "vite.stories.config.ts",
      ...(dev ? ["--mode", "development", "--minify", "false"] : []),
      "--outDir",
      join(out, "stories"),
      "--emptyOutDir",
      "--logLevel",
      "warn",
    ],
    { cwd: web, stdio: "inherit", env: dev ? { ...process.env, NODE_ENV: "development" } : process.env },
  );
  // Screenshots go to test-results; this folder is only the build.
  return () => rmSync(out, { recursive: true, force: true });
}
