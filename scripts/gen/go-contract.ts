import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const args = process.argv.slice(2);
const hasCheck = args.includes("--check");
const hasWrite = args.includes("--write");
const unknown = args.filter((arg) => arg !== "--check" && arg !== "--write");

if (unknown.length > 0 || (hasCheck && hasWrite)) {
  console.error("usage: vpx scripts/gen/go-contract.ts [--write | --check]");
  process.exit(1);
}

const mode = hasCheck ? "--check" : "--write";
const env: NodeJS.ProcessEnv = { ...process.env, CGO_ENABLED: "0" };
delete env.GOROOT;

const result = spawnSync("go", ["run", "./cmd/vibe-tsgen", mode, "--root", root], {
  cwd: root,
  env,
  stdio: "inherit",
  shell: false,
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
