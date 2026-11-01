import { dirname, join } from "node:path";

import { Effect, FileSystem } from "effect";

import { t } from "@vibevalley/i18n";

import { messageOf } from "@/errors.ts";
import { ProjectError, type Workplace, type WorkplaceRelease } from "@/project/shapes.ts";

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
