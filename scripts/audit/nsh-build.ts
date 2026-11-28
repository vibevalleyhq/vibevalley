import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const NSH_BUILD_WARNING_RE = /\bwarn\s+(?:unknown class|a string in a <View>)/iu;

export function findDisallowedBuildWarnings(output: string): string[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trimEnd())
    .filter((line) => NSH_BUILD_WARNING_RE.test(line));
}

if (import.meta.main) {
  const [appDirRel, entry, outDir] = process.argv.slice(2);
  if (!appDirRel || !entry || !outDir) {
    console.error("Usage: vpx scripts/audit/nsh-build.ts <appDir> <entry> <outDir>");
    process.exit(2);
  }
  const root = resolve(import.meta.dirname, "../..");
  const nsh = resolve(root, ".tools/bin/nsh");
  const cwd = resolve(root, appDirRel);
  const res = spawnSync(nsh, ["build", entry, "-o", outDir], { cwd, encoding: "utf8" });
  const stdout = res.stdout ?? "";
  const stderr = res.stderr ?? "";
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  const warnings = findDisallowedBuildWarnings(`${stdout}\n${stderr}`);
  if (warnings.length > 0) {
    console.error(`\n${appDirRel}/${entry}: nsh build emitted ${warnings.length} disallowed warning(s):\n${warnings.join("\n")}`);
    process.exit(1);
  }
  process.exit(res.status ?? 1);
}
