import { createReadStream, createWriteStream } from "node:fs";
import { access, link, mkdir, mkdtemp, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { errnoOf, messageOf } from "#/base/errors.ts";
import type { ServerConfig } from "#/infra/config.ts";
import { fileBlob, writeOnce } from "#/infra/files.ts";

export class StorageError extends Error {
  override readonly name = "StorageError";
}

const failed = (cause: unknown) => new StorageError(messageOf(cause), { cause });

/** f, its failure a StorageError. */
const storing = async <A>(f: () => Promise<A>): Promise<A> => {
  try {
    return await f();
  } catch (e) {
    throw failed(e);
  }
};

export function makeStorage(config: Pick<ServerConfig, "home">) {
  const root = join(config.home, "attachments");
  // Shares root's filesystem so adopt() is an atomic rename; content keys are 64-hex sha256, never "staging".
  const scratch = join(root, "staging");
  const pathOf = (key: string) => join(root, key);
  const exists = (key: string) =>
    storing(async () => {
      try {
        await access(pathOf(key));
        return true;
      } catch (e) {
        if (errnoOf(e) === "ENOENT") return false;
        throw e;
      }
    });

  return {
    scratch,
    pathOf,
    exists,
    put: (key: string, bytes: Uint8Array) => storing(() => writeOnce(pathOf(key), bytes)),
    /** Written whole to a scratch file first: a cancelled or failed source leaves nothing at key. */
    putStream: async (key: string, source: AsyncIterable<Uint8Array>, signal?: AbortSignal) => {
      const directory = await storing(async () => {
        await mkdir(scratch, { recursive: true, mode: 0o700 });
        return mkdtemp(join(scratch, ".put-"));
      });
      try {
        const temporary = join(directory, "content");
        await storing(() => pipeline(Readable.from(source), createWriteStream(temporary, { flags: "wx", mode: 0o600 }), signal ? { signal } : {}));
        await storing(async () => {
          if (!(await exists(key))) await rename(temporary, pathOf(key));
        });
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    adopt: (key: string, file: string, retain?: boolean) =>
      storing(async () => {
        await mkdir(root, { recursive: true, mode: 0o700 });
        const target = pathOf(key);
        if (retain === true) {
          await rm(target, { force: true });
          await link(file, target);
        } else await rename(file, target);
      }),
    open: (key: string, type: string) => storing(() => fileBlob(pathOf(key), type)),
    stream: async function* (key: string, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
      // Leaving the loop early destroys the read stream, so the file is not held open.
      const file = createReadStream(pathOf(key), signal ? { signal } : {});
      try {
        for await (const chunk of file) {
          if (!(chunk instanceof Uint8Array)) throw new StorageError("read a string from a byte stream");
          yield chunk;
        }
      } catch (e) {
        if (signal?.aborted === true || e instanceof StorageError) throw e;
        throw failed(e);
      }
    },
    size: (key: string) => storing(async () => (await stat(pathOf(key))).size),
    delete: (key: string) => storing(() => rm(pathOf(key), { force: true })),
  };
}
