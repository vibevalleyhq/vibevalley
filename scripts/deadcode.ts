/**
 * Dead code: files nothing reaches, exports nothing imports, dependencies nothing uses (knip, configured in knip.ts).
 * Run as `vp run deadcode`, in CI's check. knip's own report says what is dead; this adds what to do about each kind, so
 * the next step is to delete it, or to name what runs it, not to keep it alive with an import.
 */

import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

// Without its configuration hints: knip hints that it skips the page's stylesheets on every run, which is how it is set up
// (knip.ts), and a line that is always there teaches the reader to skip the report.
const ran = spawnSync("knip", ["--no-progress", "--no-config-hints"], { cwd: root, stdio: "inherit", shell: false });
if (ran.error) throw ran.error;
if (ran.status !== 0) {
  console.error(`
deadcode: what knip lists above is reached by nothing that runs.
  - An unused export: drop the \`export\` (\`vpx knip --fix --fix-type exports,types\` does it); then \`vp check\` names what that leaves
    unused in its file, and that goes too. Do not keep it alive with a new import.
  - An unused file or dependency: delete it, and its catalog entry in pnpm-workspace.yaml.
  - Something that does run it (a tool's config, a script run by name, a file loaded by a glob): add it as an entry in knip.ts,
    with a comment saying who runs it. See knip.ts.`);
  process.exit(ran.status ?? 1);
}
