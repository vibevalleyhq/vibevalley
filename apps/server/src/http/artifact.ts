// A version's content, a GET since an <iframe src> can only GET. Its headers keep an HTML page from ever running as one of
// the farm's (artifact/rules.ts); a version never changes once made, so it is cached for good.

import { Effect } from "effect";
import { artifactPrefix as prefix } from "@vibevalley/protocol";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Artifacts } from "../artifact/artifact.ts";
import { artifactHeaders } from "../artifact/rules.ts";

const notFound = () => HttpServerResponse.text("404 page not found\n", { status: 404 });

export const artifactContent = HttpRouter.add(
  "GET",
  "/api/v1/artifact/:id/:version",
  Effect.gen(function* () {
    const artifacts = yield* Artifacts;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const [id = "", version = ""] = new URL(request.url, "http://farm").pathname.slice(prefix.length).split("/");
    if (!/^[0-9a-f-]{36}$/.test(id) || !/^[1-9]\d*$/.test(version)) return notFound();
    const found = yield* artifacts.file(id, Number(version));
    if (!found) return notFound();
    const headers = artifactHeaders(found.kind);
    return yield* HttpServerResponse.file(found.path, { contentType: headers["content-type"]!, headers });
  }).pipe(Effect.orElseSucceed(notFound)),
);
