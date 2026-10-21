// The built React page (apps/web/dist) at /. A path that names no file and has no
// extension is a route of the page's own router and gets index.html, never cached; the API never falls back, so an
// unknown endpoint stays a 404.

import { existsSync, statSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

export const page = (dir: string) =>
  HttpRouter.add(
    "GET",
    "*",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = new URL(request.url, "http://farm").pathname;
      if (path.startsWith("/api/v1/")) return HttpServerResponse.text("404 page not found\n", { status: 404 });
      const clean = normalize("/" + decodeURIComponent(path));
      const file = join(dir, clean);
      if (clean !== "/index.html" && existsSync(file) && statSync(file).isFile()) return yield* HttpServerResponse.file(file);
      // The page itself is asked again every time (its assets carry their hash): a server updated under a phone's or a
      // browser's cached page would otherwise keep showing the old one.
      if (extname(clean) === "" || clean === "/index.html")
        return HttpServerResponse.setHeader(yield* HttpServerResponse.file(join(dir, "index.html")), "cache-control", "no-cache");
      return HttpServerResponse.text("404 page not found\n", { status: 404 });
    }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("404 page not found\n", { status: 404 }))),
  );
