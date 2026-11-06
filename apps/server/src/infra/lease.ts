import { closeSync, openSync, readFileSync, realpathSync, unlinkSync, writeSync } from "node:fs";
import { join } from "node:path";

import { Schema } from "effect";

import { t } from "@vibevalley/i18n";

import { errnoOf } from "#/base/errors.ts";

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errnoOf(e) === "EPERM";
  }
};

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
        } catch (e) {
          if (errnoOf(e) !== "ENOENT") throw e;
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
