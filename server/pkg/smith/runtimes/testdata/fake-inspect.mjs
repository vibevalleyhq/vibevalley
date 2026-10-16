// A fake `grok inspect --json` for the grok inventory tests. FAKE_INSPECT
// holds JSON: { "log": "<file>", "mode": "print" | "hang" | "slow-term",
// "output": "<stdout text>", "pids": "<file>" }. "print" writes output and
// exits 0; "hang" runs until killed, its pid and a detached grandchild's in
// pids; "slow-term" answers SIGTERM by exiting 300 ms later. The log gets
// {argv, cwd} at start and {stdin} for anything written to stdin.
import { spawn } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

const config = JSON.parse(process.env.FAKE_INSPECT ?? "{}");
const log = (entry) => { if (config.log) { appendFileSync(config.log, `${JSON.stringify(entry)}\n`); } };
log({ argv: process.argv.slice(2), cwd: process.cwd() });
process.stdin.on("data", (chunk) => { log({ stdin: chunk.toString() }); });

if (config.mode === "print") {
  process.stdout.write(config.output ?? "");
  process.exit(0);
}
if (config.mode === "slow-term") {
  process.on("SIGTERM", () => { setTimeout(() => { process.exit(0); }, 300); });
}
const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
grandchild.unref();
if (config.pids) {
  writeFileSync(config.pids, JSON.stringify({ agent: process.pid, grandchild: grandchild.pid }));
}
setInterval(() => {}, 1000);
