import { createAdaptorServer } from "@hono/node-server";
import { Hono } from "hono";

import { BizCode } from "@vibevalley/protocol/api";

import { bizError, messageOf } from "#/base/errors.ts";
import type { ServerConfig } from "#/infra/config.ts";
import { type Farm, makeFarm, type ServiceOptions } from "#/services.ts";

import { api, artifactContent, attachments } from "./api.ts";
import { handlers } from "./handlers.ts";
import { voiceLines } from "./line.ts";
import { mcpRoute } from "./mcp.ts";
import { mediaRoutes } from "./media.ts";
import { page } from "./page.ts";
import { replyError } from "./respond.ts";
import { subscriptions } from "./rpc.ts";
import { issueWatchStream, streams } from "./streams.ts";

/** Every route on the farm's services. */
function routes(farm: Farm, config: ServerConfig): Hono {
  const deps = { ...farm, config };
  const app = new Hono();
  app.route("/", api(handlers(deps), { log: farm.log.child("http") }));
  app.route("/", streams(deps));
  app.route("/", issueWatchStream(deps));
  app.route("/", attachments(deps));
  app.route("/", artifactContent(deps));
  app.route("/", subscriptions(deps));
  app.route("/", mediaRoutes(deps));
  app.route("/", mcpRoute(deps));
  if (config.web) app.route("/", page(config.web, farm.log.child("http/page")));
  app.onError((e) => {
    farm.log.error("vibevalley: a route failed", e);
    return replyError(bizError(BizCode.InternalError, messageOf(e)));
  });
  return app;
}

/** The farm served over HTTP, on 127.0.0.1 only. */
export interface App extends AsyncDisposable {
  /** 127.0.0.1:<port>, the port it was bound to. */
  readonly address: string;
  readonly farm: Farm;
  /** Every connection is cut, the listener closes, then the farm. */
  readonly close: () => Promise<void>;
}

/** port 0 is a free one. listening is told the address once the farm is up and served there. */
export async function app(
  config: ServerConfig,
  port: number,
  listening: (address: string) => void | Promise<void> = () => {},
  options: ServiceOptions = {},
): Promise<App> {
  // Requests that come before the farm is up wait for nothing: they are told to come back.
  let served: Hono | undefined;
  const server = createAdaptorServer({
    fetch: (request, env) => (served ? served.fetch(request, env) : replyError(bizError(BizCode.ServiceUnavailable, "starting"))),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const bound = server.address();
  if (bound === null || typeof bound === "string") throw new Error(`the server is not on a TCP port: ${bound ?? "none"}`);
  // Resolve ephemeral port 0 before building services so restored sessions and LAN forwarding never see :0.
  const resolved = bound.port === config.port ? config : { ...config, port: bound.port };
  const address = `127.0.0.1:${bound.port}`;
  let farm: Farm;
  try {
    farm = await makeFarm(resolved, options);
  } catch (e) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw e;
  }
  const lines = voiceLines({ voice: farm.voice, log: farm.log.child("http/voice") });
  server.on("upgrade", lines.upgrade);
  served = routes(farm, resolved);
  // A free port (0) is known only now: sessions opened from here on reach /mcp there.
  farm.session.setAddress(address);
  // What the lan listener lets through goes to here.
  farm.lan.setUpstream(address);

  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      // Stopping waits for every socket to close, and an event stream whose client has gone keeps its socket until its
      // next write: every connection is closed first, before the server's own close.
      const stopped = new Promise<void>((resolve) => server.close(() => resolve()));
      if ("closeAllConnections" in server) server.closeAllConnections();
      await lines.close();
      await stopped;
      await farm.close();
    })());
  try {
    await listening(address);
  } catch (e) {
    await close();
    throw e;
  }
  return { address, farm, close, [Symbol.asyncDispose]: close };
}
