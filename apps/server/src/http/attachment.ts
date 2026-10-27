// The one read that is a GET, since a page's <img src> can only GET. Named by its sha256, a file never changes: cached for good.

import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { attachmentPath } from "@vibevalley/protocol";
import { Channels } from "../channel/chat.ts";

const prefix = attachmentPath("");
const notFound = () => HttpServerResponse.text("404 page not found\n", { status: 404 });

export const attachments = HttpRouter.add(
  "GET",
  "/api/v1/attachment/:id",
  Effect.gen(function* () {
    const chat = yield* Channels;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const id = new URL(request.url, "http://farm").pathname.slice(prefix.length);
    if (!/^[0-9a-f]{64}$/.test(id)) return notFound();
    const found = yield* chat.attachment(id);
    if (!found) return notFound();
    return yield* HttpServerResponse.file(found.path, {
      contentType: found.type,
      headers: {
        "cache-control": "private, max-age=31536000, immutable",
        // Shown in the page as an image or a file, never run as one of the farm's own pages.
        "content-disposition": `${found.type.startsWith("image/") ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(found.name)}`,
        "x-content-type-options": "nosniff",
        "content-security-policy": "sandbox",
      },
    });
  }).pipe(Effect.orElseSucceed(notFound)),
);
