// The built React page (apps/web/dist) at /. A path that names no file and has no
// extension is a route of the page's own router and gets index.html, never cached; the API never falls back, so an
// unknown endpoint stays a 404. index.html goes out with the farm's locale on its <html> (data-locale, lang): the page
// takes its words from it before it draws (apps/web src/main.tsx).

import { extname, join, normalize } from "node:path";
import { Effect, FileSystem, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { currentLocale } from "@vibevalley/i18n";

const htmlLang = { zh: "zh-Hans", en: "en" } as const;

/** index.html with the locale on its <html>. */
const withLocale = (html: string) => {
  const locale = currentLocale();
  return html.replace(/<html[^>]*>/u, `<html lang="${htmlLang[locale]}" data-locale="${locale}">`);
};

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
      const fs = yield* FileSystem.FileSystem;
      const info = yield* Effect.option(fs.stat(file));
      if (clean !== "/index.html" && Option.isSome(info) && info.value.type === "File") return yield* HttpServerResponse.file(file);
      // The page itself is asked again every time (its assets carry their hash): a server updated under a phone's or a
      // browser's cached page would otherwise keep showing the old one.
      if (extname(clean) === "" || clean === "/index.html") {
        const html = yield* fs.readFileString(join(dir, "index.html"));
        return HttpServerResponse.text(withLocale(html), { contentType: "text/html; charset=utf-8", headers: { "cache-control": "no-cache" } });
      }
      return HttpServerResponse.text("404 page not found\n", { status: 404 });
    }).pipe(Effect.orElseSucceed(() => HttpServerResponse.text("404 page not found\n", { status: 404 }))),
  );
