// vp run golden:update [-- <where>…]: rewrites the golden data with what the rules answer now, then look at the diff.
// With no <where>, every golden file; with some, only theirs: a server module (core for the core state's reduce, rules
// and play; setting, issue, tool…: the tests in apps/server/src/<module>) or a package with golden data (ai: the tests
// in packages/ai).

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

// A "--" before the names (as vp run wanted) is not a name.
const wanted = process.argv.slice(2).filter((a) => a !== "--");
/** The packages whose tests read golden data, besides the server. */
const packages = ["ai"];
const isPackage = (w: string) => packages.includes(w);
const unknown = wanted.filter((w) => !isPackage(w) && !existsSync(join(root, "apps/server/src", w)));
if (unknown.length > 0) {
  console.error(`golden:update: no such place: ${unknown.join(", ")} (a folder of apps/server/src, or ${packages.join(", ")})`);
  process.exit(2);
}
// vp test itself, not the cached test task: with VIBEVALLEY_GOLDEN set the run writes files, and a replay would not.
const modules = wanted.filter((w) => !isPackage(w));
if (wanted.length === 0 || modules.length > 0) run("apps/server", ["vp", "test", "run", ...modules.map((m) => `src/${m}/`)]);
for (const p of wanted.length === 0 ? packages : wanted.filter(isPackage)) run(`packages/${p}`, ["vp", "test", "run"]);
