import { spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const uiDir = resolve(root, "apps/mac/ui");
const nsh = resolve(root, ".tools/bin/nsh");

/** Screenshot probes capture images on a window host (`--target gpui`/`macos`), not headless assertions. */
const isShotProbe = (file: string) => /(?:^|\/)(?:[^/]+\.)?shots\.test\.tsx$/u.test(file);

const suites = globSync(["**/*.test.ts", "**/*.test.tsx"], { cwd: uiDir, exclude: [".nsh/**", "build/**", "node_modules/**"] })
  .map((f) => f.replaceAll("\\", "/"))
  .filter((f) => !isShotProbe(f))
  .toSorted();

if (suites.length === 0) {
  console.error("mac-tests: no headless test suites found under apps/mac/ui");
  process.exit(1);
}

for (const suite of suites) {
  const ran = spawnSync(nsh, ["test", suite], { cwd: uiDir, stdio: "inherit", shell: false });
  if (ran.error) throw ran.error;
  if (ran.status !== 0) {
    console.error(`mac-tests: ${suite} failed (exit ${ran.status ?? 1})`);
    process.exit(ran.status ?? 1);
  }
}

console.log(`mac-tests: ${suites.length} headless suites ok`);
