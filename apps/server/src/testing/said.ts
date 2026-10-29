// What is said in a test farm, from the farm's start: the core state keeps no messages (a page follows a channel's
// room), and a test reads them as the message facts told them, by channel.

import type { ChatMessage } from "@vibevalley/protocol";
import { Context, Effect, Layer, Stream } from "effect";
import { Core } from "../core/core.ts";

export interface Said {
  readonly in: (channel: string) => ChatMessage[];
  readonly all: () => ChatMessage[];
}

export const Said = Context.Service<Said>("vibevalley/testing/Said");

export const said = Layer.effect(
  Said,
  Effect.gen(function* () {
    const core = yield* Core;
    const all: ChatMessage[] = [];
    const events = yield* core.subscribe;
    yield* Effect.forkScoped(Stream.runForEach(events, (e) => Effect.sync(() => void (e.type === "message" && all.push(e.message)))));
    return Said.of({ in: (channel) => all.filter((m) => m.channel === channel), all: () => [...all] });
  }),
);
