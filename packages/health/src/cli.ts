/**
 * vpx packages/health/src/cli.ts --config <file> [--check | --write | --json]
 *
 * With no mode, prints the report. --check fails when an escape count is off the ratchet (up: new escapes; down: lower
 * the ratchet with --write) or a hot-by-design reason names a file that is gone. --write keeps today's escape counts.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { commits, firstTime, headTime, sources } from "./collect.ts";
import { drift, type Escapes, escapesByArea, type Health, hotspots, underTodaysNames } from "./readings.ts";
import { report } from "./report.ts";

const { values } = parseArgs({ options: { config: { type: "string" }, check: { type: "boolean" }, write: { type: "boolean" }, json: { type: "boolean" } } });
if (!values.config) throw new Error("--config <file>: the repository's Health (packages/health/README.md)");

const configPath = resolve(values.config);
const health = ((await import(configPath)) as { default: Health }).default;
const root = execRoot(dirname(configPath));
const ratchetPath = resolve(root, health.ratchet);

const now = headTime(root);
const files = sources(root);
const escapes = escapesByArea(files, health);
const kept: Record<string, Escapes> = existsSync(ratchetPath) ? (JSON.parse(readFileSync(ratchetPath, "utf8")) as Record<string, Escapes>) : {};

if (values.write) {
  writeFileSync(ratchetPath, JSON.stringify(escapes, null, 2) + "\n");
  console.log(`health: kept the escape counts of ${Object.keys(escapes).length} areas in ${health.ratchet}`);
} else if (values.check) {
  const off = drift(kept, escapes);
  const tracked = new Set(files.map((f) => f.path));
  const stale = Object.keys(health.hotByDesign).filter((p) => !tracked.has(p));
  for (const d of off)
    console.error(
      d.now > d.kept
        ? `health: ${d.area} has ${d.now} ${d.kind} (kept ${d.kept}): check the new ones, or say why in the change and run --write`
        : `health: ${d.area} is down to ${d.now} ${d.kind} (kept ${d.kept}): run --write to lower the ratchet`,
    );
  for (const p of stale) console.error(`health: ${p} is hot by design but gone: drop its reason`);
  if (off.length > 0 || stale.length > 0) process.exit(1);
  console.log(`health: escapes on the ratchet in ${Object.keys(escapes).length} areas`);
} else {
  const hot = hotspots(underTodaysNames(commits(root, now - 2 * health.days * 86_400_000)), files, now, health.days, health.counted);
  console.log(
    values.json
      ? JSON.stringify({ now, hotspots: hot, escapes, kept }, null, 2)
      : report({
          now,
          days: health.days,
          compared: firstTime(root) <= now - 2 * health.days * 86_400_000,
          hot,
          hotByDesign: health.hotByDesign,
          escapes,
          kept,
        }),
  );
}

/** The repository's root: the config may sit in a folder of it. */
function execRoot(from: string) {
  let dir = from;
  while (!existsSync(resolve(dir, ".git"))) {
    const up = dirname(dir);
    if (up === dir) throw new Error(`${from} is not in a git repository`);
    dir = up;
  }
  return dir;
}
