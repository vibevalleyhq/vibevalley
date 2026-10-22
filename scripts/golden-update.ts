// pnpm run golden:update [-- <where>…]: rewrites the golden data with what the rules answer now, then look at the diff.
// With no <where>, every golden file; with some, only theirs: a module name (core for the core state's reduce, rules
// and play; setting, issue, tool…) the tests in apps/server/src/<module>.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const env = { ...process.env, VIBEVALLEY_GOLDEN: "update" };

function run(cwd: string, cmd: string[]) {
  console.log(`$ (${cwd}) ${cmd.join(" ")}`);
  const done = spawnSync(cmd[0]!, cmd.slice(1), { cwd: join(root, cwd), env, stdio: "inherit" });
  if (done.status !== 0) process.exit(done.status ?? 1);
}

const wanted = process.argv.slice(2);
const unknown = wanted.filter((w) => !existsSync(join(root, "apps/server/src", w)));
if (unknown.length > 0) {
  console.error(`golden:update: no such place: ${unknown.join(", ")} (a folder of apps/server/src)`);
  process.exit(2);
}
run("apps/server", ["pnpm", "run", "test", ...wanted.map((m) => `src/${m}/`)]);
