import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

import { Hono } from "hono";

import { currentLocale } from "@vibevalley/i18n";

import { errnoOf } from "#/base/errors.ts";
import type { Logger } from "#/infra/log.ts";

import { fileResponse, notFound } from "./respond.ts";

const htmlLang = { zh: "zh-Hans", en: "en" } as const;

/** index.html with the locale on its <html>. */
const withLocale = (html: string) => {
  const locale = currentLocale();
  return html.replace(/<html[^>]*>/u, `<html lang="${htmlLang[locale]}" data-locale="${locale}">`);
};

const isFile = async (path: string) => {
  try {
    return (await stat(path)).isFile();
  } catch (e) {
    // Not there is not a file: the page's own routes fall through to index.html.
    if (errnoOf(e) === "ENOENT" || errnoOf(e) === "ENOTDIR") return false;
    throw e;
  }
};

export function page(dir: string, log: Logger): Hono {
  const app = new Hono();
  app.get("*", async (c) => {
    try {
      const path = new URL(c.req.url).pathname;
      if (path.startsWith("/api/v1/")) return notFound();
      const clean = normalize("/" + decodeURIComponent(path));
      const file = join(dir, clean);
      if (clean !== "/index.html" && (await isFile(file))) return (await fileResponse(file)) ?? notFound();
      // The page itself is asked again every time (its assets carry their hash).
      if (extname(clean) === "" || clean === "/index.html") {
        const html = await readFile(join(dir, "index.html"), "utf8");
        return new Response(withLocale(html), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
      }
      return notFound();
    } catch (e) {
      log.debug("page: not served", e);
      return notFound();
    }
  });
  return app;
}
