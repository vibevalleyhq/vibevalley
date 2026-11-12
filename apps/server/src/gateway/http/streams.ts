import { Hono } from "hono";
import type { z } from "zod";

import { type Clock, isAbort } from "@vibevalley/async";
import { eventsPath, livePath, statePath, streamHeartbeatMs, type Streams } from "@vibevalley/protocol";
import { ApiError } from "@vibevalley/protocol/api";
import * as S from "@vibevalley/protocol/schema";

import { Inconsistent } from "#/base/errors.ts";
import { problemOf, wireOf } from "#/base/json.ts";
import { bounded, type Core } from "#/core/core.ts";
import type { Logger } from "#/infra/log.ts";
import { gauge } from "#/infra/metrics.ts";
import type { Issue } from "#/modules/issue/issue.ts";
import { watchIssue } from "#/modules/issue/watch.ts";
import type { Session } from "#/modules/session/session.ts";

import { empty } from "./respond.ts";

/** Each stream's Schema: what readStream (packages/protocol/src/stream.ts) takes its payloads to be. */
const schemas = { [statePath]: S.StateFrame, [eventsPath]: S.ServerEvent, [livePath]: S.LiveEvent } satisfies {
  [P in keyof Streams]: z.ZodType<Streams[P]>;
};

const encoder = new TextEncoder();
const ping = encoder.encode(": ping\n\n");

export interface SseDeps {
  readonly log: Logger;
  readonly clock: Clock;
}

/** events as server-sent events, one `data:` line each, with a comment line every streamHeartbeatMs however quiet it is.
 * The events are read only as fast as the client takes them, through `bounded`: these clients reconnect from a snapshot,
 * so one that falls behind has its stream ended. An event that does not fit its Schema ends the stream too. The client
 * going away aborts the signal events is given. */
export function sse<A>(name: string, events: (signal: AbortSignal) => AsyncIterable<A>, schema: z.ZodType<A>, deps: SseDeps): Response {
  const encode = (event: A) => {
    const wire = wireOf(event);
    const got = schema.safeParse(wire);
    if (!got.success) throw new Inconsistent(`not of its wire shape: ${problemOf(got.error)}`, { cause: got.error });
    return JSON.stringify(wire);
  };
  const open = gauge(`vibevalley.sse.open.${name}`);
  const stop = new AbortController();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const inner = readable.getReader();
  // The body pulls one chunk at a time, so a write waits for the client to read; cancelling it stops the writers
  // before it cancels what they write to.
  const body = new ReadableStream<Uint8Array>(
    {
      pull: async (c) => {
        const r = await inner.read();
        if (r.done) c.close();
        else c.enqueue(r.value);
      },
      cancel: async (reason) => {
        stop.abort();
        await inner.cancel(reason);
      },
    },
    { highWaterMark: 0 },
  );
  let wrote = false;
  const pings = async () => {
    try {
      await deps.clock.sleep(0, stop.signal);
      if (!wrote && !stop.signal.aborted) await writer.write(ping);
      for (;;) {
        await deps.clock.sleep(streamHeartbeatMs, stop.signal);
        await writer.write(ping);
      }
    } catch (e) {
      // Ended with the stream: the client went away, or the events ended.
      if (!stop.signal.aborted) deps.log.debug(`http.${name}: heartbeat stopped`, e);
    }
  };
  const run = async () => {
    open.add(1);
    const beating = pings();
    try {
      for await (const event of bounded(events(stop.signal), "http." + name, deps.log, 64, stop.signal)) {
        wrote = true;
        await writer.write(encoder.encode(`data: ${encode(event)}\n\n`));
      }
      stop.abort();
      await writer.close();
    } catch (e) {
      const gone = stop.signal.aborted || isAbort(e);
      stop.abort();
      if (!gone) {
        deps.log.error(`vibevalley: http.${name}: invalid event; closing stream`, e);
        // Errors the body: the client sees the stream fail, not end.
        await writer.abort(e).catch((why: unknown) => deps.log.debug(`http.${name}: the stream was already gone`, why));
      }
    } finally {
      await beating;
      open.add(-1);
    }
  };
  // run catches all it throws: the stream's failure is the body's.
  void run();
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "x-accel-buffering": "no",
    },
  });
}

export function streams(deps: SseDeps & { readonly core: Core }): Hono {
  const { core } = deps;
  const app = new Hono();
  app.get(statePath, () => sse("state", (signal) => core.states(signal), schemas[statePath], deps));
  app.get(eventsPath, () => sse("events", (signal) => core.events(signal), schemas[eventsPath], deps));
  app.get(livePath, () => sse("live", (signal) => core.live(signal), schemas[livePath], deps));
  return app;
}

export function issueWatchStream(deps: SseDeps & { readonly core: Core; readonly issue: Issue; readonly session: Session }): Hono {
  const app = new Hono();
  app.get("/api/v1/issue/watch/:id", async (c) => {
    const id = new URL(c.req.url).pathname.split("/").at(-1) ?? "";
    let initial;
    try {
      initial = await deps.issue.get(id);
    } catch (e) {
      if (e instanceof ApiError) return empty(404);
      throw e;
    }
    return sse("issue.watch", (signal) => watchIssue(initial, deps.core, deps.session, deps.log, signal), S.IssueWatch, deps);
  });
  return app;
}
