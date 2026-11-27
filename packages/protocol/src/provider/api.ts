import type { Endpoint } from "../endpoint";
import * as S from "./schema";
import type * as T from "./shapes.gen";

export interface ProviderHandlers {
  readonly "provider.get": () => Promise<T.ProviderStatus>;
  readonly "provider.update": (a: T.ProviderUpdate) => Promise<T.ProviderStatus>;
  readonly "provider.verify": (a: T.ProviderVerifyRequest) => Promise<T.ProviderStatus>;
  readonly "provider.voice.list": (a: T.ProviderVoiceRequest) => Promise<T.ProviderVoiceListing>;
}

export const providerEndpoints: readonly Endpoint[] = [
  { op: "provider.get", about: [], input: undefined, result: S.ProviderStatus, can: ["user"] },
  { op: "provider.update", about: [], input: S.ProviderUpdate, result: S.ProviderStatus, can: ["user"] },
  { op: "provider.verify", about: [], input: S.ProviderVerifyRequest, result: S.ProviderStatus, can: ["user"] },
  { op: "provider.voice.list", about: ["connection"], input: S.ProviderVoiceRequest, result: S.ProviderVoiceListing, can: ["user"] },
];
