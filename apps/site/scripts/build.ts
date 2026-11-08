import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { sealSiteMigrationGraph } from "vibevalley/style-migration";
import { createBuilder } from "vite-plus";

import { prerender } from "./prerender";

const root = resolve(import.meta.dirname, "..");
const builder = await createBuilder({ root, configFile: resolve(root, "vite.config.ts") });
await builder.buildApp();
const { handleRequest }: { handleRequest: (request: Request) => Promise<Response> } = await import(pathToFileURL(resolve(root, "dist/server/server.js")).href);
const output = resolve(root, "dist/client");
await prerender(handleRequest, output);
await mkdir(output, { recursive: true });
const origin = "https://vibevalley.dev";
const languages = [
  { path: "/", lang: "zh-CN" },
  { path: "/en/", lang: "en" },
];
const links = languages.map(({ path, lang }) => `<xhtml:link rel="alternate" hreflang="${lang}" href="${origin}${path}"/>`).join("");
await writeFile(
  resolve(output, "sitemap-0.xml"),
  `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">${languages.map(({ path }) => `<url><loc>${origin}${path}</loc>${links}</url>`).join("")}</urlset>`,
);
await writeFile(
  resolve(output, "sitemap-index.xml"),
  `<?xml version="1.0" encoding="UTF-8"?><sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><sitemap><loc>${origin}/sitemap-0.xml</loc></sitemap></sitemapindex>`,
);
await sealSiteMigrationGraph(output);
