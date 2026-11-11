import { randomUUID } from "node:crypto";
import { openAsBlob } from "node:fs";
import { link, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { type Clock, Semaphore } from "@vibevalley/async";

import { errnoOf, Inconsistent, messageOf } from "#/base/errors.ts";

import type { Logger } from "./log.ts";

// The native Blob keeps multipart uploads disk-backed rather than buffering the file.
export const fileBlob = (path: string, type: string): Promise<Blob> => openAsBlob(path, { type });

export class NotWritten extends Error {
  override readonly name = "NotWritten";
}

const notWritten = (cause: unknown) => new NotWritten(messageOf(cause), { cause });

// Publish hash-named files only after writing all bytes; cancellation must not leave a partial file at the hash.
export async function writeOnce(path: string, bytes: Uint8Array): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    const directory = await mkdtemp(join(dirname(path), ".upload-"));
    try {
      const temporary = join(directory, "asset");
      await writeFile(temporary, bytes, { mode: 0o600 });
      await link(temporary, path).catch((e: unknown) => {
        if (errnoOf(e) !== "EEXIST") throw e;
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } catch (e) {
    throw notWritten(e);
  }
}

/** A user's file (config.json, settings.json); one whose read fails is set aside and read as undefined. */
export async function readOrSetAside<A>(
  file: string,
  read: (text: string) => A | Promise<A>,
  startsFrom: string,
  deps: { readonly clock: Clock; readonly log: Logger },
): Promise<A | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (errnoOf(e) === "ENOENT") return undefined;
    throw e;
  }
  try {
    return await read(text);
  } catch (e) {
    const failure = messageOf(e);
    const aside = `${file}.unreadable-${deps.clock.now()}`;
    try {
      await rename(file, aside);
    } catch (moved) {
      throw new Inconsistent(`${file} cannot be read, and could not be kept aside as ${aside}: ${messageOf(moved)}`, { cause: moved });
    }
    deps.log.warn(`${file} could not be read (${failure}): kept as ${aside}, ${startsFrom}`);
    return undefined;
  }
}

/** A file kept by the server: one write at a time, the last asked for wins. */
export interface KeptFile {
  /** Writes body now, after the write in flight: what is kept only once it is on disk (a profile, a setting). */
  readonly save: (body: string) => Promise<void>;
  /** Writes the latest body soon (after the wait), the changes in between joining that write. */
  readonly soon: (body: () => string) => void;
  /** The write soon asked for, now: its service's close calls it last, so the last state is on disk. */
  readonly close: () => Promise<void>;
}

/** soonMs: how long a soon write waits after the first change, so a burst is one write and a crash loses no more. */
export function keptFile(
  path: string,
  deps: { readonly clock: Clock; readonly log: Logger },
  options: { readonly mode?: number; readonly soonMs?: number } = {},
): KeptFile {
  const one = new Semaphore(1);
  const write = (data: string) =>
    one.with(async () => {
      try {
        await mkdir(dirname(path), { recursive: true });
        const temp = join(dirname(path), `${basename(path)}.${randomUUID()}.tmp`);
        await writeFile(temp, data, { mode: options.mode ?? 0o644 });
        await rename(temp, path);
      } catch (e) {
        throw notWritten(e);
      }
    });
  let pending: (() => string) | undefined;
  let waiting: AbortController | undefined;
  const flush = async () => {
    waiting = undefined;
    const body = pending;
    pending = undefined;
    if (body) await write(body()).catch((e: unknown) => deps.log.error(`${path} could not be saved`, e));
  };
  return {
    save: (body) => {
      pending = undefined;
      return write(body);
    },
    soon: (body) => {
      pending = body;
      if (waiting !== undefined) return;
      const wait = new AbortController();
      waiting = wait;
      void deps.clock.sleep(options.soonMs ?? 0, wait.signal).then(flush, () => undefined);
    },
    close: async () => {
      waiting?.abort();
      await flush();
    },
  };
}
