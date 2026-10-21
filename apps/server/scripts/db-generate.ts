// Writes db/generated from db/migrations and db/queries with effect-sqlc (the owner's generator, beside this repo in
// ../effect-sqlc or at $EFFECT_SQLC), then fits it to this server: effect 4's stable path for the sql modules, and no
// node-postgres pool (the server runs PGlite: src/base/db.ts). --check fails when db/generated is stale.

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const db = resolve(import.meta.dirname, "../db");
const tool = process.env.EFFECT_SQLC ?? resolve(import.meta.dirname, "../../../../effect-sqlc");
const cli = join(tool, "dist/cli.js");
if (!existsSync(cli)) throw new Error(`no effect-sqlc at ${tool}: build it there (pnpm build) or set EFFECT_SQLC`);

const check = process.argv.includes("--check");
const work = mkdtempSync(join(tmpdir(), "vibevalley-db-"));
for (const dir of ["migrations", "queries"]) cpSync(join(db, dir), join(work, dir), { recursive: true });
cpSync(join(db, "effect-sqlc.json"), join(work, "effect-sqlc.json"));
execFileSync("node", [cli, "generate", "--config", join(work, "effect-sqlc.json")], { stdio: ["ignore", "ignore", "inherit"] });

const made = new Map<string, string>();
for (const name of readdirSync(join(work, "generated"))) {
  if (name === "db.ts" || !name.endsWith(".ts")) continue;
  made.set(name, readFileSync(join(work, "generated", name), "utf8").replaceAll('"effect/unstable/sql"', '"effect/sql"'));
}
rmSync(work, { recursive: true });

const out = join(db, "generated");
const have = existsSync(out) ? readdirSync(out).filter((n) => n.endsWith(".ts")) : [];
if (check) {
  const stale = [...new Set([...have, ...made.keys()])].filter((n) => made.get(n) !== (have.includes(n) ? readFileSync(join(out, n), "utf8") : undefined));
  if (stale.length > 0) {
    console.error(`db/generated is stale (${stale.join(", ")}): bun run db:generate in apps/server`);
    process.exit(1);
  }
} else {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out);
  for (const [name, body] of made) writeFileSync(join(out, name), body, { flag: "w" });
}
