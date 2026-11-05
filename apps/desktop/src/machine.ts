// What a Mac has one of (the global shortcut, the island at the notch) goes to the channel opened first (channel.ts): a
// file in the user's temporary folder names its process. One whose process is gone is taken over.

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ownerFile = () => join(tmpdir(), "vibevalley-machine-owner");

/** Whether a process of that id is running: signal 0 asks without sending. */
function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: it runs as someone else, which is still running.
    return e instanceof Error && "code" in e && e.code === "EPERM";
  }
}

/** Takes the Mac's shared things for this process unless another running channel has them; says which has them. */
export function claimMachine(channel: string, file = ownerFile()): { readonly mine: boolean; readonly owner: string } {
  const said = existsSync(file) ? readFileSync(file, "utf8").trim().split(" ") : [];
  const [pid, owner] = [Number(said[0]), said.slice(1).join(" ")];
  if (Number.isInteger(pid) && pid !== process.pid && running(pid)) return { mine: false, owner };
  writeFileSync(file, `${process.pid} ${channel}\n`);
  return { mine: true, owner: channel };
}

/** Lets them go on the way out, if they are this process's. */
export function releaseMachine(file = ownerFile()) {
  if (existsSync(file) && Number(readFileSync(file, "utf8").split(" ")[0]) === process.pid) rmSync(file, { force: true });
}
