// One server per home: .vibevalley.lock holds the pid of the server using it. Node
// has no flock, so a lock whose process is gone is stale and is taken over.

import { baseWording } from "./words.ts";
import { closeSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
};

export class HomeTaken extends Error {}

/** Takes the home, or throws HomeTaken; the function it returns gives it back. */
export function leaseHome(home: string): () => void {
  const path = join(realpathSync(home), ".vibevalley.lock");
  for (let tries = 0; tries < 2; tries++) {
    try {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, String(process.pid));
      closeSync(fd);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (readFileSync(path, "utf8") === String(process.pid)) unlinkSync(path);
        } catch {
          // Already gone.
        }
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(path, "utf8"));
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new HomeTaken(baseWording().homeTaken(home));
      unlinkSync(path);
    }
  }
  throw new HomeTaken(baseWording().homeUnlocked(home));
}
