import { expect, it } from "vite-plus/test";
import { Layer } from "effect";
import { HttpRouter } from "effect/http";
import { Mcp } from "../mcp/mcp.ts";
import { Orchestrator } from "../orchestrator/orchestrator.ts";
import { mcpRoute } from "./mcp.ts";

it("forwards a disconnect to the Web handler", async () => {
  let aborted = false;
  const handler = Mcp.of({
    handle: (request) =>
      new Promise<Response>((resolve) => {
        request.signal.addEventListener(
          "abort",
          () => {
            aborted = true;
            resolve(new Response(null, { status: 499 }));
          },
          { once: true },
        );
      }),
  });
  const routes = mcpRoute.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(Mcp, handler),
        Layer.succeed(
          Orchestrator,
          Orchestrator.of({
            answerer: () => () => undefined,
          } as unknown as Orchestrator["Service"]),
        ),
      ),
    ),
  );
  const { handler: handle, dispose } = HttpRouter.toWebHandler(routes);
  try {
    const controller = new AbortController();
    const pending = handle(new Request("http://farm/mcp", { method: "POST", body: "{}", signal: controller.signal }));
    controller.abort();
    await pending.catch(() => undefined);
    expect(aborted).toBe(true);
  } finally {
    await dispose();
  }
});
