// The long-lived event streams: the frames for the page, the side events and the live events, as server-sent events
// with a ping every streamHeartbeatMs, so a proxy does not close a quiet one and a reader can tell a quiet stream from a
// dead one (packages/protocol/src/stream.ts).

import { Effect, Metric, Schedule, type Schema, Stream } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/http";

import { eventsPath, livePath, statePath, streamHeartbeatMs, type Streams } from "@vibevalley/protocol";
import * as S from "@vibevalley/protocol/schema";

import { wireJson } from "@/base/wire.ts";
import { bounded } from "@/core/bounded.ts";
import { Core } from "@/core/core.ts";

/** Each stream's Schema: what readStream (packages/protocol/src/stream.ts) takes its payloads to be. */
const schemas = { [statePath]: S.StateFrame, [eventsPath]: S.SideEvent, [livePath]: S.LiveEvent } satisfies {
  [P in keyof Streams]: Schema.Codec<Streams[P], unknown>;
};

const encoder = new TextEncoder();

/** The event streams open now, by stream: up when one starts, down when it ends however it ends. */
const open = Metric.counter("vibevalley.sse.open", { description: "Event streams open now, by stream" });

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
  const pings = Stream.fromSchedule(Schedule.spaced(streamHeartbeatMs)).pipe(Stream.map(() => encoder.encode(": ping\n\n")));
  const counted = open.pipe(Metric.withAttributes({ stream: name }));
  const body = Stream.unwrap(Effect.as(Metric.update(counted, 1), Stream.merge(data, pings, { haltStrategy: "left" }))).pipe(
    Stream.ensuring(Metric.update(counted, -1)),
  );
  return HttpServerResponse.stream(body, {
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
      Effect.sync(() => sse("state", core.states, schemas[statePath])),
    );
    yield* router.add(
      "GET",
      eventsPath,
      Effect.sync(() => sse("events", core.events, schemas[eventsPath])),
    );
    yield* router.add(
      "GET",
      livePath,
      Effect.sync(() => sse("live", core.live, schemas[livePath])),
    );
  }),
);
