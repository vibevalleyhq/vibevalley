import { createServer, type IncomingMessage } from "node:http";

/** What a fake server is asked: the path, the Authorization header and the body. */
export interface Asked {
  readonly url: string;
  readonly authorization: string;
  readonly body: string;
}

/** A server on a free port of 127.0.0.1 answering each request with what answer gives: JSON with status 200, or a
 * status alone. Closed when disposed. */
export async function fakeServer(answer: (asked: Asked) => { readonly json: unknown } | { readonly status: number }) {
  const bodyOf = async (req: IncomingMessage) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return Buffer.concat(parts).toString("utf8");
  };
  const server = createServer((req, res) => {
    void bodyOf(req).then((body) => {
      const said = answer({ url: req.url ?? "", authorization: req.headers.authorization ?? "", body });
      if ("json" in said) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(said.json));
      } else {
        res.writeHead(said.status);
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port to listen on");
  return {
    url: `http://127.0.0.1:${address.port}`,
    [Symbol.asyncDispose]: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
