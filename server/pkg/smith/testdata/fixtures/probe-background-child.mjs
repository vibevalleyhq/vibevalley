/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone untyped child-process fixture. */
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

// The grandchild inherits the probe's output pipes and ignores SIGTERM.
// Report only after that handler is installed, then optionally exit the
// group leader without waiting for the grandchild or closing its pipes.
const grandchild = spawn(process.execPath, ["-e", `
process.on("SIGTERM", () => {});
process.send("ready");
setTimeout(() => { process.exit(0); }, 60_000);
`], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
grandchild.once("message", () => {
  const file = process.env.OAR_FIXTURE_PIDS;
  if (file === undefined) { throw new Error("missing pid file"); }
  writeFileSync(`${file}.tmp`, JSON.stringify({ agent: process.pid, grandchild: grandchild.pid }));
  renameSync(`${file}.tmp`, file);
  if (process.env.OAR_FIXTURE_EARLY_EXIT === "1") { process.exit(0); }
});
