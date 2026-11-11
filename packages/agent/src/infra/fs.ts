import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { Effect, type FileSystem, Option } from "effect";

import { type AgentFailed, agentFailed, errnoOf } from "../core/errors.ts";

export interface DirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

export interface FileStat {
  readonly isDirectory: boolean;
  readonly mtimeMs: number;
}

/** Narrow filesystem port for the standalone and hosted agent: backed by Effect `FileSystem` when given, else `node:fs/promises`. */
export interface AgentFs {
  readonly readText: (path: string) => Effect.Effect<string, AgentFailed>;
  readonly readTextIfExists: (path: string) => Effect.Effect<string | undefined, AgentFailed>;
  readonly writeText: (path: string, content: string) => Effect.Effect<void, AgentFailed>;
  readonly appendText: (path: string, content: string) => Effect.Effect<void, AgentFailed>;
  readonly makeDir: (path: string) => Effect.Effect<void, AgentFailed>;
  readonly rename: (from: string, to: string) => Effect.Effect<void, AgentFailed>;
  readonly readDir: (path: string) => Effect.Effect<readonly string[], AgentFailed>;
  readonly readDirEntries: (path: string) => Effect.Effect<readonly DirEntry[], AgentFailed>;
  readonly stat: (path: string) => Effect.Effect<FileStat, AgentFailed>;
}

const isNodeNotFound = (e: AgentFailed): boolean => errnoOf(e.cause) === "ENOENT";

const mtimeMsOf = (mtime: Option.Option<Date>): number => (Option.isSome(mtime) ? mtime.value.getTime() : 0);

const readNodeText = (path: string): Effect.Effect<string, AgentFailed> => Effect.tryPromise({ try: () => readFile(path, "utf8"), catch: agentFailed });

const nodeAgentFs: AgentFs = {
  readText: readNodeText,
  readTextIfExists: (path) =>
    readNodeText(path).pipe(
      Effect.map((text): string | undefined => text),
      Effect.catchIf(isNodeNotFound, () => Effect.undefined),
    ),
  writeText: (path, content) => Effect.tryPromise({ try: () => writeFile(path, content), catch: agentFailed }),
  appendText: (path, content) => Effect.tryPromise({ try: () => appendFile(path, content), catch: agentFailed }),
  makeDir: (path) => Effect.asVoid(Effect.tryPromise({ try: () => mkdir(path, { recursive: true }), catch: agentFailed })),
  rename: (from, to) => Effect.tryPromise({ try: () => rename(from, to), catch: agentFailed }),
  readDir: (path) => Effect.tryPromise({ try: () => readdir(path), catch: agentFailed }),
  readDirEntries: (path) =>
    Effect.map(Effect.tryPromise({ try: () => readdir(path, { withFileTypes: true }), catch: agentFailed }), (entries) =>
      entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() })),
    ),
  stat: (path) =>
    Effect.map(Effect.tryPromise({ try: () => stat(path), catch: agentFailed }), (info) => ({ isDirectory: info.isDirectory(), mtimeMs: info.mtimeMs })),
};

function fromFileSystem(fs: FileSystem.FileSystem): AgentFs {
  return {
    readText: (path) => Effect.mapError(fs.readFileString(path), agentFailed),
    readTextIfExists: (path) =>
      fs.readFileString(path).pipe(
        Effect.map((text): string | undefined => text),
        Effect.catchIf(
          (e) => e.reason._tag === "NotFound",
          () => Effect.undefined,
        ),
        Effect.mapError(agentFailed),
      ),
    writeText: (path, content) => Effect.mapError(fs.writeFileString(path, content), agentFailed),
    appendText: (path, content) => Effect.mapError(fs.writeFileString(path, content, { flag: "a" }), agentFailed),
    makeDir: (path) => Effect.mapError(fs.makeDirectory(path, { recursive: true }), agentFailed),
    rename: (from, to) => Effect.mapError(fs.rename(from, to), agentFailed),
    readDir: (path) => Effect.mapError(fs.readDirectory(path), agentFailed),
    readDirEntries: (path) =>
      Effect.gen(function* () {
        const names = yield* Effect.mapError(fs.readDirectory(path), agentFailed);
        return yield* Effect.forEach(
          names,
          (name) =>
            fs.stat(join(path, name)).pipe(
              Effect.map((info) => ({ name, isDirectory: info.type === "Directory" })),
              Effect.catchIf(
                (e) => e.reason._tag === "NotFound",
                () => Effect.succeed({ name, isDirectory: false }),
              ),
              Effect.mapError(agentFailed),
            ),
          { concurrency: 16 },
        );
      }),
    stat: (path) =>
      fs.stat(path).pipe(
        Effect.mapBoth({
          onSuccess: (info) => ({ isDirectory: info.type === "Directory", mtimeMs: mtimeMsOf(info.mtime) }),
          onFailure: agentFailed,
        }),
      ),
  };
}

export const agentFsOf = (fs?: FileSystem.FileSystem | AgentFs): AgentFs =>
  fs === undefined ? nodeAgentFs : "readTextIfExists" in fs ? fs : fromFileSystem(fs);
