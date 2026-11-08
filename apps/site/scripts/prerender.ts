import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const pages = [
  { path: "/", file: "index.html" },
  { path: "/en/", file: "en/index.html" },
  { path: "/404.html", file: "404.html" },
] as const;

export async function prerender(handleRequest: (request: Request) => Promise<Response>, directory: string) {
  const rendered = await Promise.all(
    pages.map(async (page) => {
      const response = await handleRequest(new Request(`https://vibevalley.dev${page.path}`));
      if (response.status !== 200 || response.headers.get("content-type")?.includes("text/html") !== true) {
        throw new Error(`Cannot prerender ${page.path}: expected HTML with status 200, received ${response.status}`);
      }
      const html = await response.text();
      if (!html.includes("</html>")) throw new Error(`Incomplete HTML for ${page.path}`);
      return { file: join(directory, page.file), html };
    }),
  );
  await Promise.all(
    rendered.map(async ({ file, html }) => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, html);
    }),
  );
}
