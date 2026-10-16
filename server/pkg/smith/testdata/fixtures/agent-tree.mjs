/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument -- Standalone untyped child-process fixture. */
import { spawn } from "node:child_process";
import { renameSync, writeFileSync } from "node:fs";

/*
 * Opt-in process-tree behavior for a fake agent process, switched by env and
 * run on import, so any fixture can carry it (`import "./agent-tree.mjs"`, or
 * `node --import <this file> <fixture>`):
 * - OAR_FIXTURE_PIDS=<file>: start a grandchild (a tool the agent runs, here
 *   a Node process sleeping for 60 s) and write {"agent", "grandchild"} to <file>.
 * - OAR_FIXTURE_DETACH_TOOL=1 (POSIX): start that grandchild in a session of
 *   its own (setsid), out of the agent's process group, the way claude runs a
 *   Bash tool command.
 * - OAR_FIXTURE_IGNORE_SIGTERM=1: ignore SIGTERM and stay alive past stdin
 *   EOF, so only SIGKILL ends the agent. With OAR_FIXTURE_LATE_TOOL=<file>, the
 *   SIGTERM also starts a second tool in a session of its own and writes its
 *   pid to <file>: one the agent started after its kill began.
 * Everything it starts ends on its own within a minute, so a failed test
 * leaks nothing for long.
 */
const sleeper = ["-e", "setTimeout(() => {}, 60000)"];
if (process.env.OAR_FIXTURE_IGNORE_SIGTERM === "1") {
  const lateTool = process.env.OAR_FIXTURE_LATE_TOOL;
  process.on("SIGTERM", () => {
    if (lateTool !== undefined) {
      const tool = spawn(process.execPath, sleeper, { stdio: "ignore", detached: true });
      tool.once("spawn", () => {
        writeFileSync(`${lateTool}.tmp`, String(tool.pid));
        renameSync(`${lateTool}.tmp`, lateTool);
      });
    }
  });
  setTimeout(() => {
    process.exit(0);
  }, 60_000);
}
const pidFile = process.env.OAR_FIXTURE_PIDS;
if (pidFile !== undefined) {
  const grandchild = spawn(process.execPath, sleeper, { stdio: "ignore", detached: process.env.OAR_FIXTURE_DETACH_TOOL === "1" });
  grandchild.once("spawn", () => {
    writeFileSync(`${pidFile}.tmp`, JSON.stringify({ agent: process.pid, grandchild: grandchild.pid }));
    renameSync(`${pidFile}.tmp`, pidFile);
  });
}
