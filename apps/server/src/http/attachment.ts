// The one read that is a GET, since a page's <img src> can only GET. Named by its sha256, a file never changes: cached for good.

import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { attachmentPath } from "@vibevalley/protocol";

import { Channels } from "@/channel/chat.ts";

const prefix = attachmentPath("");
const inline = (type: string) => /^(image|video|audio)\//u.test(type) || type === "application/pdf";
const notFound = () => HttpServerResponse.text("404 page not found\n", { status: 404 });

export const attachments = HttpRouter.add(
  "GET",
  "/api/v1/attachment/:id",
  Effect.gen(function* () {
    const chat = yield* Channels;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const id = new URL(request.url, "http://farm").pathname.slice(prefix.length);
    if (!/^[0-9a-f]{64}$/u.test(id)) return notFound();
    const found = yield* chat.attachment(id);
    if (!found) return notFound();
    const pdf = found.type === "application/pdf";
    return yield* HttpServerResponse.file(found.path, {
      contentType: found.type,
      headers: {
        "cache-control": "private, max-age=31536000, immutable",
        // Shown in the page (an image, a video, a sound) or a tab of its own (a PDF), else saved: never run as one of the
        // farm's own pages. The browser's PDF viewer does not open under a sandbox; nosniff keeps a PDF a PDF.
        "content-disposition": `${inline(found.type) ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(found.name)}`,
        "x-content-type-options": "nosniff",
        ...(pdf ? {} : { "content-security-policy": "sandbox" }),
      },
    });
  }).pipe(Effect.orElseSucceed(notFound)),
);
