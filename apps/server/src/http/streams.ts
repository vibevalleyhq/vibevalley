// The long-lived event streams: the frames for the page, the side events and the live
// events, as server-sent events with a ping every 20 s so a proxy does not close a quiet one.

import { eventsPath, livePath, statePath } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";
import { Effect, Schedule, type Schema, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { bounded } from "../core/bounded.ts";
import { wireJson } from "../base/wire.ts";
import { Core } from "../core/core.ts";

const heartbeatMs = 20_000;

const encoder = new TextEncoder();

function sse<A>(name: string, events: Stream.Stream<A>, schema: Schema.Codec<A>) {
  const encode = wireJson(schema);
  // These clients reconnect from a snapshot. Internal fact subscribers cannot do that and must not end on a full buffer.
  const data = bounded(events, "http." + name).pipe(
    Stream.mapEffect((event) =>
      encode(event).pipe(
        Effect.map((json) => encoder.encode(`data: ${json}\n\n`)),
        Effect.tapError((error) => Effect.logError(`vibevalley: http.${name}: invalid event; closing stream`, error)),
      ),
    ),
  );
  const pings = Stream.fromSchedule(Schedule.spaced(heartbeatMs)).pipe(Stream.map(() => encoder.encode(": ping\n\n")));
  return HttpServerResponse.stream(Stream.merge(data, pings, { haltStrategy: "left" }), {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

export const streams = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const core = yield* Core;
    yield* router.add(
      "GET",
      statePath,
      Effect.sync(() => sse("state", core.states, S.StateFrame)),
    );
    yield* router.add(
      "GET",
      eventsPath,
      Effect.sync(() => sse("events", core.events, S.SideEvent)),
    );
    yield* router.add(
      "GET",
      livePath,
      Effect.sync(() => sse("live", core.live, S.LiveEvent)),
    );
  }),
);
