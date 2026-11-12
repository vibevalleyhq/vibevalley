import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

import { getMimeType } from "hono/utils/mime";

import { type ApiError, ApiErrorEnvelope } from "@vibevalley/protocol/api";

import { errnoOf } from "#/base/errors.ts";

/** Encodes a structured ApiError into its full JSON wire envelope with the status mapped from its BizCode. */
export const replyError = (e: ApiError): Response => Response.json(ApiErrorEnvelope.parse(e.toEnvelope()), { status: e.status });

export const notFound = (): Response => new Response("404 page not found\n", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });

export const empty = (status: number, headers?: Record<string, string>): Response => new Response(null, { status, ...(headers ? { headers } : {}) });

/** A request's body as text, or undefined once it grows past max: what is left of it is not read. */
export async function textUpTo(request: Request, max: number): Promise<string | undefined> {
  if (request.body === null) return "";
  const reader: ReadableStreamDefaultReader<Uint8Array> = request.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      return undefined;
    }
    parts.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(parts));
}

export interface FileOptions {
  readonly status?: number;
  /** From the file's extension when absent. */
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
  readonly offset?: number;
  readonly bytesToRead?: number;
}

/** A file on disk as the answer, streamed; undefined when there is no such file. */
export async function fileResponse(path: string, options: FileOptions = {}): Promise<Response | undefined> {
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) return undefined;
    size = info.size;
  } catch (e) {
    if (errnoOf(e) === "ENOENT" || errnoOf(e) === "ENOTDIR") return undefined;
    throw e;
  }
  const start = options.offset ?? 0;
  const length = options.bytesToRead ?? size - start;
  const body = length <= 0 ? null : Readable.toWeb(createReadStream(path, { start, end: start + length - 1 }));
  return new Response(body as ReadableStream<Uint8Array> | null, {
    status: options.status ?? 200,
    headers: {
      "content-type": options.contentType ?? getMimeType(path) ?? "application/octet-stream",
      "content-length": String(Math.max(0, length)),
      ...options.headers,
    },
  });
}
