// Builds the page once for the run, into a folder of this run's own (two runs at once do not share one).
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";

const web = join(import.meta.dirname, "..");

export default function setup() {
  const out = join(web, ".test", `run-${process.pid}`);
  process.env.VIBEVALLEY_TEST_OUT = out;
  execFileSync("bunx", ["vp", "build", "--outDir", join(out, "dist"), "--emptyOutDir", "--logLevel", "warn"], { cwd: web, stdio: "inherit" });
  // Screenshots go to test-results; this folder is only the build.
  return () => rmSync(out, { recursive: true, force: true });
}
