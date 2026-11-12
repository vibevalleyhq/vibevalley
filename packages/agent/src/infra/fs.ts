import { appendFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";

import { agentFailed, errnoOf } from "../core/errors.ts";

export interface DirEntry {
  readonly name: string;
  readonly isDirectory: boolean;
}

export interface FileStat {
  readonly isDirectory: boolean;
  readonly mtimeMs: number;
}

/** Narrow filesystem port for the standalone and hosted agent: `node:fs/promises` unless the host gives another. Each
 * failure is an AgentFailed whose cause is the system call's error. */
export interface AgentFs {
  readonly readText: (path: string) => Promise<string>;
  readonly readTextIfExists: (path: string) => Promise<string | undefined>;
  readonly writeText: (path: string, content: string) => Promise<void>;
  readonly appendText: (path: string, content: string) => Promise<void>;
  readonly makeDir: (path: string) => Promise<void>;
  readonly rename: (from: string, to: string) => Promise<void>;
  readonly readDir: (path: string) => Promise<readonly string[]>;
  readonly readDirEntries: (path: string) => Promise<readonly DirEntry[]>;
  readonly stat: (path: string) => Promise<FileStat>;
}

/** f, its failure an AgentFailed. */
async function failing<A>(f: () => Promise<A>): Promise<A> {
  try {
    return await f();
  } catch (e) {
    throw agentFailed(e);
  }
}

const nodeAgentFs: AgentFs = {
  readText: (path) => failing(() => readFile(path, "utf8")),
  readTextIfExists: async (path) => {
    try {
      return await readFile(path, "utf8");
    } catch (e) {
      if (errnoOf(e) === "ENOENT") return undefined;
      throw agentFailed(e);
    }
  },
  writeText: (path, content) => failing(() => writeFile(path, content)),
  appendText: (path, content) => failing(() => appendFile(path, content)),
  makeDir: (path) => failing(async () => void (await mkdir(path, { recursive: true }))),
  rename: (from, to) => failing(() => rename(from, to)),
  readDir: (path) => failing(() => readdir(path)),
  readDirEntries: (path) => failing(async () => (await readdir(path, { withFileTypes: true })).map((e) => ({ name: e.name, isDirectory: e.isDirectory() }))),
  stat: (path) =>
    failing(async () => {
      const info = await stat(path);
      return { isDirectory: info.isDirectory(), mtimeMs: info.mtimeMs };
    }),
};

export const agentFsOf = (fs?: AgentFs): AgentFs => fs ?? nodeAgentFs;
