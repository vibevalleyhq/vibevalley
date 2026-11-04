// 「安装命令行」: the app's command line (Resources/bin/<command>, written by scripts/package.ts) linked into ~/.local/bin,
// which needs no administrator and outlives the app's updates (the link names where the app is, not a version).

import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { t } from "@vibevalley/i18n";
import type { CommandLineState } from "@vibevalley/protocol/host";

export function commandLine(o: {
  readonly command: string;
  /** The launcher in the app's resources. */
  readonly launcher: string;
  /** ~/.local/bin. */
  readonly bin: string;
  /** Where the login shell's PATH is kept (server.ts shellPath); the process's own when there is none yet. */
  readonly keptPath: string;
}) {
  const link = join(o.bin, o.command);
  const state = (): CommandLineState => {
    const at = lstatSync(link, { throwIfNoEntry: false });
    const installed = at?.isSymbolicLink() === true && readlinkSync(link) === o.launcher;
    const path = existsSync(o.keptPath) ? readFileSync(o.keptPath, "utf8") : (process.env.PATH ?? "");
    return { command: o.command, link, installed, onPath: path.trim().split(":").includes(o.bin), taken: at !== undefined && !installed };
  };
  return {
    state,
    install: (): CommandLineState => {
      const now = state();
      // Another program's file of that name is not ours to replace.
      if (now.taken) throw new Error(t("desktop.commandLine.taken", { link }));
      if (!now.installed) {
        mkdirSync(o.bin, { recursive: true });
        symlinkSync(o.launcher, link);
      }
      return state();
    },
    remove: (): CommandLineState => {
      if (state().installed) unlinkSync(link);
      return state();
    },
  };
}
