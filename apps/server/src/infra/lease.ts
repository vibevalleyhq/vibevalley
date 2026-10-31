// One server per home: .vibevalley.lock holds the pid of the server using it. Node
// has no flock, so a lock whose process is gone is stale and is taken over. server.json says where that server listens,
// so the command line finds it on whatever port it got (the desktop app asks for a free one).

import { closeSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

import { t } from "@vibevalley/i18n";

import { jsonOrNone } from "@/base/json.ts";
import { errnoOf } from "@/errors.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errnoOf(e) === "EPERM";
  }
};

/** server.json: where the server using this home listens, and its process. */
const announcement = jsonOrNone(Schema.Struct({ url: Schema.String, pid: Schema.Finite }));

export class HomeTaken extends Schema.TaggedError<HomeTaken, { readonly brand: unique symbol }>()("HomeTaken", { message: Schema.String }) {}

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
      if (errnoOf(e) !== "EEXIST") throw e;
      const pid = Number(readFileSync(path, "utf8"));
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new HomeTaken({ message: t("server.base.homeTaken", { home }) });
      unlinkSync(path);
    }
  }
  throw new HomeTaken({ message: t("server.base.homeUnlocked", { home }) });
}

/** The home a server or the command line uses: VIBEVALLEY_HOME, or ~/.vibevalley (as loadConfig reads it). */
export const homeOf = (env: Readonly<Record<string, string | undefined>> = process.env) => env.VIBEVALLEY_HOME || join(homedir(), ".vibevalley");

/** Says where this server listens, for as long as it does; the function it returns takes it back. */
export function announce(home: string, url: string): () => void {
  const path = join(home, "server.json");
  writeFileSync(path, JSON.stringify({ url, pid: process.pid }) + "\n", { mode: 0o600 });
  return () => {
    try {
      if (announcement(readFileSync(path, "utf8"))?.pid === process.pid) unlinkSync(path);
    } catch {
      // Already gone.
    }
  };
}

/** Where the server using this home listens; undefined when none says so or it has stopped. */
export function announced(home: string): string | undefined {
  try {
    const said = announcement(readFileSync(join(home, "server.json"), "utf8"));
    return said && alive(said.pid) ? said.url : undefined;
  } catch {
    return undefined;
  }
}
