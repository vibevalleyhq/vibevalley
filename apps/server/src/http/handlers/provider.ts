import { Effect } from "effect";

import type { ProviderHandlers } from "@vibevalley/protocol/api";

import { Provider } from "#/provider/provider.ts";

export const providerHandlers = Effect.gen(function* () {
  const provider = yield* Provider;
  const done: ProviderHandlers = {
    "provider.get": () => Effect.sync(provider.status),
    "provider.update": (body) => provider.update(body),
    "provider.voice.list": (body) => provider.voices(body),
    "provider.model.list": (body) => provider.models(body),
  };
  return done;
});
