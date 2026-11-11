import { createServer } from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpRouter, HttpServer } from "effect/http";

import { Lan } from "#/gateway/lan/lan.ts";
import type { ServerConfig } from "#/infra/config.ts";
import { Session } from "#/modules/session/session.ts";
import { type ServiceOptions, services } from "#/services.ts";

import { api, artifactContent, attachments, mossLine } from "./api.ts";
import { handlers } from "./handlers.ts";
import { mcpRoute } from "./mcp.ts";
import { mediaInputContent, mediaSpeechStream, mediaUploads } from "./media.ts";
import { page } from "./page.ts";
import { subscriptions } from "./rpc.ts";
import { issueWatchStream, streams } from "./streams.ts";

const routes = (config: ServerConfig["Service"]) =>
  Layer.mergeAll(
    Layer.unwrap(Effect.map(handlers, (h) => api(h))),
    streams,
    issueWatchStream,
    attachments,
    artifactContent,
    subscriptions,
    mossLine,
    mediaUploads,
    mediaInputContent,
    mediaSpeechStream,
    mcpRoute,
    config.web ? page(config.web) : Layer.empty,
  );

/** The address it listens on, once it does; told to who needs it, then to listening. */
const ready = (listening: (address: string) => Effect.Effect<void>) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      if (server.address._tag === "UnixPathAddress") return;
      const address = `127.0.0.1:${server.address.port}`;
      // A free port (0) is known only now: sessions opened from here on reach /mcp there.
      (yield* Session).setAddress(address);
      // What the lan listener lets through goes to here.
      (yield* Lan).setUpstream(address);
      yield* listening(address);
    }),
  );

const served = (config: ServerConfig["Service"], listening: (address: string) => Effect.Effect<void>, options: ServiceOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const server = yield* HttpServer.HttpServer;
      const boundPort = server.address._tag === "UnixPathAddress" ? config.port : server.address.port;
      // Resolve ephemeral port 0 before building services so restored sessions and LAN forwarding never see :0.
      const resolved = boundPort === config.port ? config : { ...config, port: boundPort };
      return HttpRouter.serve(routes(resolved), { disableListenLog: true, disableLogger: true }).pipe(
        Layer.merge(ready(listening)),
        Layer.provideMerge(services(resolved, options)),
      );
    }),
  );

/** port 0 is a free one. */
export const app = (
  config: ServerConfig["Service"],
  port: number,
  listening: (address: string) => Effect.Effect<void> = () => Effect.void,
  options: ServiceOptions = {},
) => {
  const server = createServer();
  return served(config, listening, options).pipe(
    // Stopping waits for every socket to close, and an event stream whose client has gone keeps its socket until its next write: every connection is closed first, before the server's own close.
    Layer.merge(Layer.effectDiscard(Effect.addFinalizer(() => Effect.sync(() => server.closeAllConnections())))),
    Layer.provide(NodeHttpServer.layer(() => server, { host: "127.0.0.1", port })),
  );
};
