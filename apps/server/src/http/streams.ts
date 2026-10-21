// The long-lived event streams: the frames for the page, the side events and the live
// events, as server-sent events with a ping every 20 s so a proxy does not close a quiet one.

import { eventsPath, livePath, statePath } from "@vibevalley/protocol";
import { Effect, Schedule, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { Core } from "../core/core.ts";

const heartbeatMs = 20_000;

const encoder = new TextEncoder();

function sse<A>(events: Stream.Stream<A>) {
  const data = events.pipe(Stream.map((e) => encoder.encode(`data: ${JSON.stringify(e)}\n\n`)));
  const pings = Stream.fromSchedule(Schedule.spaced(heartbeatMs)).pipe(Stream.map(() => encoder.encode(": ping\n\n")));
  return HttpServerResponse.stream(Stream.merge(data, pings, { haltStrategy: "left" }), {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache", "x-accel-buffering": "no" },
  });
}

export const streams = HttpRouter.use((router) =>
  Effect.gen(function* () {
    const core = yield* Core;
    yield* router.add(
      "GET",
      statePath,
      Effect.sync(() => sse(core.states)),
    );
    yield* router.add(
      "GET",
      eventsPath,
      Effect.sync(() => sse(core.events)),
    );
    yield* router.add(
      "GET",
      livePath,
      Effect.sync(() => sse(core.live)),
    );
  }),
);
