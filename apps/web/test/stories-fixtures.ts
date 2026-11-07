import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";

import { expect, test as base } from "./browser";

const types: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
  ".wasm": "application/wasm",
};
export const test = base.extend<object, { stories: string }>({
  stories: [
    async ({ browserName: _browserName }, use) => {
      const out = process.env.VIBEVALLEY_TEST_OUT;
      if (!out || !existsSync(join(out, "stories", "index.html")))
        throw new Error("Stories build missing. Fix: assign this spec to a stories suite in test/projects.ts and use its entry point.");
      const root = join(out, "stories");
      const server = createServer((req, res) => {
        const path = normalize(decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname)).replace(/^(\.\.[/\\])+/u, "");
        let file = join(root, path);
        if (!existsSync(file) || statSync(file).isDirectory()) file = join(root, "index.html");
        res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
        createReadStream(file).pipe(res);
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        await use(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      } finally {
        await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      }
    },
    { scope: "worker" },
  ],
  baseURL: async ({ stories }, use) => use(stories),
});
export { expect };
