import { Hono } from "hono";

import { t } from "@vibevalley/i18n";
import { ApiError, BizCode } from "@vibevalley/protocol/api";
import { MediaInput } from "@vibevalley/protocol/schema";

import { bizError } from "#/base/errors.ts";
import { jsonText, wireJson } from "#/base/json.ts";
import type { Logger } from "#/infra/log.ts";
import type { Media } from "#/modules/media/media.ts";

import { empty, fileResponse, replyError } from "./respond.ts";
import { fromTheFarm } from "./rpc.ts";

const uploadMax = 512_000_000;

/** The request's body as it comes, at most max bytes: a client that goes away, or a body past max, is the upload refused. */
async function* bodyOf(request: Request, max: number): AsyncGenerator<Uint8Array> {
  if (request.body === null) return;
  const reader: ReadableStreamDefaultReader<Uint8Array> = request.body.getReader();
  let size = 0;
  try {
    for (;;) {
      let r;
      try {
        r = await reader.read();
      } catch (e) {
        throw new ApiError(BizCode.MediaRefused, t("server.media.inputDisconnected"), { cause: e });
      }
      if (r.done) return;
      size += r.value.byteLength;
      if (size > max) throw bizError(BizCode.MediaRefused, t("server.media.inputDisconnected"));
      yield r.value;
    }
  } finally {
    reader.releaseLock();
  }
}

export interface MediaRouteDeps {
  readonly media: Media;
  readonly log: Logger;
}

// The upload is deliberately absent from the LAN listener: only the local user can upload new inputs.
export function mediaRoutes(deps: MediaRouteDeps): Hono {
  const { media } = deps;
  const app = new Hono();

  app.put("/api/v1/media/input/:id/content", async (c) => {
    const request = c.req.raw;
    if (!fromTheFarm(request.headers)) return replyError(bizError(BizCode.Forbidden, "forbidden"));
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/octet-stream")
      return replyError(bizError(BizCode.UnsupportedMediaType, "application/octet-stream required"));
    if (Number(request.headers.get("content-length") ?? 0) > uploadMax)
      return replyError(bizError(BizCode.PayloadTooLarge, `the body exceeds ${uploadMax} bytes`));
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/u.test(id)) return replyError(bizError(BizCode.MediaNotFound, "media input not found"));
    try {
      const data = await media.inputs.upload(id, bodyOf(request, uploadMax), request.signal);
      return new Response(`{"bizCode":0,"message":"ok","data":${wireJson(MediaInput)(data)}}`, { headers: { "content-type": "application/json" } });
    } catch (e) {
      if (e instanceof ApiError) return replyError(e);
      throw e;
    }
  });

  app.get("/api/v1/media/input/:id/content", async (c) => {
    const request = c.req.raw;
    if (!fromTheFarm(request.headers)) return empty(403);
    const id = c.req.param("id");
    if (!/^[0-9a-f-]{36}$/u.test(id)) return empty(404);
    try {
      const found = await media.inputs.content(id);
      let start = 0;
      let end = found.size - 1;
      const range = request.headers.get("range") ?? undefined;
      if (range !== undefined) {
        const parts = /^bytes=(\d*)-(\d*)$/u.exec(range);
        if (!parts || (!parts[1] && !parts[2])) return empty(416, { "content-range": `bytes */${found.size}` });
        start = parts[1] ? Number(parts[1]) : Math.max(0, found.size - Number(parts[2]));
        end = parts[1] && parts[2] ? Math.min(Number(parts[2]), found.size - 1) : found.size - 1;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= found.size)
          return empty(416, { "content-range": `bytes */${found.size}` });
      }
      const res = await fileResponse(found.path, {
        status: range === undefined ? 200 : 206,
        contentType: found.mime,
        offset: start,
        bytesToRead: end - start + 1,
        headers: {
          "accept-ranges": "bytes",
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox",
          "content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(found.name)}`,
          ...(range === undefined ? {} : { "content-range": `bytes ${start}-${end}/${found.size}` }),
        },
      });
      return res ?? empty(404);
    } catch (e) {
      // Whatever kept it from being read (gone, changed, refused) is a 404 to the page.
      deps.log.debug(`media input ${id}: not served`, e);
      return empty(404);
    }
  });

  app.get("/api/v1/media/speech/:id/stream", async (c) => {
    const request = c.req.raw;
    if (!fromTheFarm(request.headers)) return replyError(bizError(BizCode.Forbidden, "forbidden"));
    let events: AsyncIterable<unknown>;
    try {
      events = media.speechEvents(c.req.param("id"), request.signal);
    } catch (e) {
      if (e instanceof ApiError) return replyError(e);
      throw e;
    }
    const encoder = new TextEncoder();
    const it = events[Symbol.asyncIterator]();
    const body = new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          const r = await it.next();
          if (r.done === true) controller.close();
          else controller.enqueue(encoder.encode(`${jsonText(r.value)}\n`));
        },
        cancel: async () => {
          await it.return?.();
        },
      },
      { highWaterMark: 0 },
    );
    return new Response(body, {
      headers: { "content-type": "application/x-ndjson", "cache-control": "no-store", "x-accel-buffering": "no", "x-content-type-options": "nosniff" },
    });
  });

  return app;
}
