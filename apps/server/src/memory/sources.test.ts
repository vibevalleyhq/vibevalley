import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber } from "effect";

import type { MemorySourceConfig } from "#/setting/memorySources.ts";

import { makeSources, type Source } from "./sources.ts";

const quiet = (name: string, more: Partial<Source> = {}): Source => ({
  name,
  unavailable: () => undefined,
  stop: Effect.void,
  prefetch: () => Effect.succeed([]),
  syncTurn: () => Effect.void,
  sessionEnded: () => Effect.void,
  search: () => Effect.succeed({ found: [], coverage: "" }),
  list: () => Effect.succeed([]),
  add: () => Effect.undefined,
  forget: () => Effect.void,
  can: { list: true, forget: true, transcripts: false },
  ...more,
});

it.live("an operation a change of sources cuts short fails with why the sources were replaced", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let configs: readonly MemorySourceConfig[] = [{ kind: "everos", url: "http://first", enabled: true }];
      const asked = yield* Deferred.make<void>();
      const sources = yield* makeSources({
        local: quiet("local"),
        configured: () => configs,
        build: (c) => quiet(c.kind, { forget: () => Effect.andThen(Deferred.succeed(asked, undefined), Effect.never) }),
      });
      const forgetting = yield* Effect.forkChild(sources.forget("lab", "everos:m1"));
      yield* Deferred.await(asked);
      configs = [{ kind: "everos", url: "http://second", enabled: true }];
      yield* sources.info;
      const error = yield* Effect.flip(Fiber.join(forgetting));
      expect(error.message).toBe("memory sources changed; outside operation canceled");
    }),
  ),
);
