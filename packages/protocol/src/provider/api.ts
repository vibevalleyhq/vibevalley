import type { Endpoint } from "../endpoint";
import * as S from "./schema";
import type * as T from "./shapes";

export interface ProviderHandlers {
  readonly "provider.get": () => Promise<T.ProviderStatus>;
  readonly "provider.update": (a: T.ProviderUpdate) => Promise<T.ProviderStatus>;
  readonly "provider.voice.list": (a: T.ProviderVoiceRequest) => Promise<T.ProviderVoiceListing>;
  readonly "provider.model.list": (a: T.ProviderModelRequest) => Promise<T.ProviderModelListing>;
}

export const providerEndpoints: readonly Endpoint[] = [
  { op: "provider.get", about: [], input: undefined, result: S.ProviderStatus, can: ["user"] },
  { op: "provider.update", about: [], input: S.ProviderUpdate, result: S.ProviderStatus, can: ["user"] },
  { op: "provider.voice.list", about: ["connection"], input: S.ProviderVoiceRequest, result: S.ProviderVoiceListing, can: ["user"] },
  { op: "provider.model.list", about: [], input: S.ProviderModelRequest, result: S.ProviderModelListing, can: ["user"] },
];
