// A GET since an <iframe src> can only GET; a version never changes once made, so it is cached for good. Its headers keep an HTML page from running as one of the farm's (artifact/policy.ts).

import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { artifactPrefix as prefix } from "@vibevalley/protocol";
import { artifactId } from "@vibevalley/protocol/schema";

import { Artifact } from "@/artifact/artifact.ts";
import { artifactHeaders } from "@/artifact/policy.ts";

const notFound = () => HttpServerResponse.text("404 page not found\n", { status: 404 });

export const artifactContent = HttpRouter.add(
  "GET",
  "/api/v1/artifact/:id/:version",
  Effect.gen(function* () {
    const artifacts = yield* Artifact;
    const request = yield* HttpServerRequest.HttpServerRequest;
    const [id = "", version = ""] = new URL(request.url, "http://farm").pathname.slice(prefix.length).split("/");
    if (!/^[0-9a-f-]{36}$/u.test(id) || !/^[1-9]\d*$/u.test(version)) return notFound();
    const path = yield* artifacts.file(artifactId(id), Number(version));
    if (!path) return notFound();
    return yield* HttpServerResponse.file(path, { contentType: artifactHeaders["content-type"]!, headers: artifactHeaders });
  }).pipe(Effect.orElseSucceed(notFound)),
);
