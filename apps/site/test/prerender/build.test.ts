import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vite-plus/test";

import { pages, prerender } from "../../scripts/prerender";

const html = "<!DOCTYPE html><html><head></head><body>Static content</body></html>";
const directory = async () => {
  const path = await mkdtemp(join(tmpdir(), "vv-prerender-"));
  return {
    path,
    async [Symbol.asyncDispose]() {
      await rm(path, { recursive: true, force: true });
    },
  };
};

test("renders every static route before writing its document", async () => {
  await using output = await directory();
  const requests: string[] = [];
  await prerender(async (request) => {
    requests.push(new URL(request.url).pathname);
    return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
  }, output.path);
  expect(requests).toEqual(pages.map((page) => page.path));
  expect(await Promise.all(pages.map((page) => readFile(join(output.path, page.file), "utf8")))).toEqual(pages.map(() => html));
});

for (const invalid of [
  { name: "server failure", status: 500, type: "text/html", body: html },
  { name: "redirect", status: 302, type: "text/html", body: html },
  { name: "non-HTML content", status: 200, type: "application/json", body: "{}" },
  { name: "incomplete HTML", status: 200, type: "text/html", body: "<!DOCTYPE html><html>" },
]) {
  test(`regression: ${invalid.name} prevents static documents from being published`, async () => {
    await using output = await directory();
    await expect(
      prerender(
        async (request) =>
          new URL(request.url).pathname === "/en/"
            ? new Response(invalid.body, { status: invalid.status, headers: { "content-type": invalid.type } })
            : new Response(html, { headers: { "content-type": "text/html" } }),
        output.path,
      ),
    ).rejects.toThrow();
    expect(await readdir(output.path)).toEqual([]);
  });
}

test("regression: a rejected renderer fails without writing partial documents", async () => {
  await using output = await directory();
  await expect(
    prerender(async () => {
      throw new Error("Renderer failed");
    }, output.path),
  ).rejects.toThrow("Renderer failed");
  expect(await readdir(output.path)).toEqual([]);
});
