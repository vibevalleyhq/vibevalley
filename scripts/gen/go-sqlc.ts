import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "../..");
const configPath = resolve(root, "sqlc.yaml");
const defaultHostSqlc = "/Users/lucasay/go/1.26.1/bin/sqlc";
const sqlcModule = "github.com/sqlc-dev/sqlc/cmd/sqlc@v1.31.1";

const args = process.argv.slice(2);
const hasCheck = args.includes("--check");
const hasWrite = args.includes("--write");
const unknown = args.filter((arg) => arg !== "--check" && arg !== "--write");

if (unknown.length > 0 || (hasCheck && hasWrite)) {
  console.error("usage: vpx scripts/gen/go-sqlc.ts [--write | --check]");
  process.exit(1);
}

const subcommand = hasCheck ? "diff" : "generate";
const env: NodeJS.ProcessEnv = { ...process.env, CGO_ENABLED: "0" };
delete env.GOROOT;

function canRunSqlc(bin: string): boolean {
  const probe = spawnSync(bin, ["version"], {
    cwd: root,
    env,
    stdio: "ignore",
    shell: false,
  });
  return probe.status === 0;
}

function resolveInvocation(): { cmd: string; cmdArgs: string[] } {
  const override = env.SQLC_BIN?.trim();
  if (override !== undefined && override !== "") {
    return { cmd: override, cmdArgs: [subcommand, "-f", configPath] };
  }
  if (canRunSqlc("sqlc")) {
    return { cmd: "sqlc", cmdArgs: [subcommand, "-f", configPath] };
  }
  if (existsSync(defaultHostSqlc) && canRunSqlc(defaultHostSqlc)) {
    return { cmd: defaultHostSqlc, cmdArgs: [subcommand, "-f", configPath] };
  }
  return { cmd: "go", cmdArgs: ["run", sqlcModule, subcommand, "-f", configPath] };
}

const { cmd, cmdArgs } = resolveInvocation();
const result = spawnSync(cmd, cmdArgs, {
  cwd: root,
  env,
  stdio: "inherit",
  shell: false,
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
