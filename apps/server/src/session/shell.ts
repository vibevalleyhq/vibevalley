import { dirname, join } from "node:path";

import { Effect, FileSystem } from "effect";

import { t } from "@vibevalley/i18n";

import { messageOf } from "@/errors.ts";
import { ProjectError, type Workplace, type WorkplaceRelease } from "@/project/shapes.ts";

// codex runs every command as `/bin/zsh -lc '<command>'`; the label shows the
// command, not the shell around it.

const shellWrap = /^(?:\S*\/)?(?:zsh|bash|sh) -l?c (.+)$/su;

/** The command inside a shell's -c, read as the one shell word the shell would see; anything else comes back as it is. */
export function shellCommand(command: string): string {
  const m = shellWrap.exec(command.trim());
  if (!m) return command;
  const word = shellWord(m[1]!);
  return word ?? command;
}

/** POSIX quoting: '…' as written, "…" with \" \\ \$ \` escaped, and bare characters with \ escaping one. */
function shellWord(s: string): string | undefined {
  let out = "";
  for (let i = 0; i < s.length;) {
    const c = s[i]!;
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) return undefined;
      out += s.slice(i + 1, end);
      i = end + 1;
    } else if (c === '"') {
      i++;
      for (;;) {
        if (i >= s.length) return undefined;
        if (s[i] === '"') {
          i++;
          break;
        }
        if (s[i] === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1]!)) {
          out += s[i + 1];
          i += 2;
          continue;
        }
        out += s[i];
        i++;
      }
    } else if (c === "\\") {
      if (i + 1 >= s.length) return undefined;
      out += s[i + 1];
      i += 2;
    } else if (c === " " || c === "\t" || c === "\n") return undefined;
    else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Context files survive suspension and never share a project checkout. */
export const contextPlace = Effect.fn("Session.contextPlace")(function* (
  workRoot: string,
  id: string,
): Effect.fn.Return<Workplace, ProjectError, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const root = join(workRoot, "contexts");
  const make = Effect.gen(function* () {
    yield* fs.makeDirectory(root, { recursive: true });
    const work = yield* fs.realPath(workRoot);
    const parent = yield* fs.realPath(root);
    if (dirname(parent) !== work) return yield* new ProjectError({ message: t("server.project.outside") });
    const directory = yield* fs.makeTempDirectory({ directory: parent, prefix: id + "-" });
    const cwd = yield* fs.realPath(directory);
    if (dirname(cwd) !== parent) return yield* new ProjectError({ message: t("server.project.outside") });
    return { project: "", cwd };
  });
  return yield* make.pipe(Effect.mapError((cause) => new ProjectError({ message: messageOf(cause), cause })));
});

/** A failed opening can discard only an empty context directory. */
export const releaseContextPlace = Effect.fn("Session.releaseContextPlace")(function* (
  place: Workplace,
): Effect.fn.Return<WorkplaceRelease, never, FileSystem.FileSystem> {
  const fs = yield* FileSystem.FileSystem;
  const kept = (why: string): WorkplaceRelease => ({ kept: true, reason: t("server.session.life.contextKept", { cwd: place.cwd, why }) });
  return yield* Effect.gen(function* () {
    if ((yield* fs.readDirectory(place.cwd)).length > 0) return kept(t("server.session.life.contextHasFiles"));
    yield* fs.remove(place.cwd, { recursive: true });
    return { kept: false as const };
  }).pipe(Effect.catch((cause) => Effect.succeed(kept(messageOf(cause)))));
});
