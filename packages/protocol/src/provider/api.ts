import type { Effect } from "effect";

import type { ApiError, Endpoint } from "../endpoint";
import * as S from "./schema";
import type * as T from "./shapes";

export interface ProviderHandlers<R = never> {
  readonly "provider.get": () => Effect.Effect<T.ProviderStatus, ApiError, R>;
  readonly "provider.update": (a: T.ProviderUpdate) => Effect.Effect<T.ProviderStatus, ApiError, R>;
  readonly "provider.voice.list": (a: T.ProviderVoiceRequest) => Effect.Effect<T.ProviderVoiceListing, ApiError, R>;
  readonly "provider.model.list": (a: T.ProviderModelRequest) => Effect.Effect<T.ProviderModelListing, ApiError, R>;
}

export const providerEndpoints: readonly Endpoint[] = [
  { op: "provider.get", about: [], input: undefined, result: S.ProviderStatus, can: ["user"] },
  { op: "provider.update", about: [], input: S.ProviderUpdate, result: S.ProviderStatus, can: ["user"] },
  { op: "provider.voice.list", about: ["connection"], input: S.ProviderVoiceRequest, result: S.ProviderVoiceListing, can: ["user"] },
  { op: "provider.model.list", about: [], input: S.ProviderModelRequest, result: S.ProviderModelListing, can: ["user"] },
];
