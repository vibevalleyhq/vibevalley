// The farm over HTTP on loopback: every route on the farm's services. main.ts runs it; tests
// run it on a free port.

import { createServer } from "node:http";
import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";
import type { Config } from "../base/config.ts";
import { handlers } from "../handlers.ts";
import { Lan } from "../lan/lan.ts";
import { type ServiceOptions, services } from "../services.ts";
import { Sessions } from "../session/session.ts";
import { api } from "./api.ts";
import { mcpRoute } from "./mcp.ts";
import { page } from "./page.ts";
import { streams } from "./streams.ts";

const routes = (config: Config) =>
  Layer.mergeAll(Layer.unwrap(Effect.map(handlers, (h) => api(h))), streams, mcpRoute, config.web ? page(config.web) : Layer.empty);

/** The address it listens on, once it does; told to who needs it, then to listening. */
const ready = (listening: (address: string) => Effect.Effect<void>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      if (server.address._tag === "UnixPathAddress") return;
      const address = `127.0.0.1:${server.address.port}`;
      // A free port (0) is known only now: sessions opened from here on reach /mcp there.
      (yield* Sessions).setAddress(address);
      // What the lan listener lets through goes to here.
      (yield* Lan).setUpstream(address);
      yield* listening(address);
    }),
  );

/** port 0 is a free one. */
export const app = (config: Config, port: number, listening: (address: string) => Effect.Effect<void> = () => Effect.void, options: ServiceOptions = {}) => {
  const server = createServer();
  return HttpRouter.serve(routes(config), { disableListenLog: true, disableLogger: true }).pipe(
    Layer.merge(ready(listening)),
    // Stopping waits for every socket to close, and an event stream whose client has gone keeps its socket until its
    // next write (a frame, or the ping 20 s on): every connection is closed first, before the server's own close.
    Layer.merge(Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections())))),
    Layer.provideMerge(services(config, options)),
    Layer.provide(NodeHttpServer.layer(() => server, { host: "127.0.0.1", port })),
  );
};
