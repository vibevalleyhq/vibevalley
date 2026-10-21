// pnpm run golden:update [-- <where>…]: rewrites the golden data with what the rules answer now, then look at the diff.
// With no <where>, every golden file; with some, only theirs: `protocol` is packages/protocol's (reduce, rules, play),
// a module name (setting, issue, tool…) the tests in apps/server/src/<module>.

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
const unknown = wanted.filter((w) => w !== "protocol" && !existsSync(join(root, "apps/server/src", w)));
if (unknown.length > 0) {
  console.error(`golden:update: no such place: ${unknown.join(", ")} (protocol, or a folder of apps/server/src)`);
  process.exit(2);
}
const modules = wanted.filter((w) => w !== "protocol");
if (wanted.length === 0 || wanted.includes("protocol"))
  run("packages/protocol", ["pnpm", "run", "test", ...(wanted.length === 0 ? [] : ["src/rules/golden.test.ts"])]);
if (wanted.length === 0) run("apps/server", ["pnpm", "run", "test"]);
else if (modules.length > 0) run("apps/server", ["pnpm", "run", "test", ...modules.map((m) => `src/${m}/`)]);
