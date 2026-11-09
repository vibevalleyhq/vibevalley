import { type Effect, Schema } from "effect";

import { type ApiError, type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface VoiceHandlers<R = never> {
  /** A line heard on the call that is on, without its id: refused unless one call is. */
  readonly "voice.hear": (a: { readonly text: string; readonly agent?: string; readonly sendKey?: string }) => Effect.Effect<void, ApiError, R>;
  readonly "voice.grant.create": () => Effect.Effect<T.AgoraGrant, ApiError, R>;
  readonly "voice.grant.renew": (a: T.VoiceGrantRenew) => Effect.Effect<T.AgoraGrant, ApiError, R>;
  readonly "voice.call.start": (a: T.VoiceCallStart) => Effect.Effect<T.VoiceCall, ApiError, R>;
  readonly "voice.call.stop": (a: T.VoiceCall) => Effect.Effect<void, ApiError, R>;
  readonly "voice.call.hear": (a: T.VoiceHeard) => Effect.Effect<void, ApiError, R>;
  readonly "voice.call.say": (a: T.VoiceSaid) => Effect.Effect<void, ApiError, R>;
  readonly "voice.dictate": (a: T.DictateRequest) => Effect.Effect<T.Dictated, ApiError, R>;
  /** Whether MOSS Live takes the key: a session is attached and closed again, nothing is said. */
  readonly "voice.moss.verify": () => Effect.Effect<T.Validation, ApiError, R>;
}

export const voiceEndpoints: readonly Endpoint[] = [
  {
    op: "voice.hear",
    about: [],
    input: input({ text: Schema.String, agent: Schema.optionalKey(Schema.String), sendKey: Schema.optionalKey(Schema.String) }),
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "voice.moss.verify",
    about: [],
    input: undefined,
    result: S.Validation,
    can: ["owner"],
  },
  {
    op: "voice.grant.create",
    about: [],
    input: undefined,
    result: S.AgoraGrant,
    can: ["owner", "remote"],
  },
  {
    op: "voice.grant.renew",
    about: [],
    input: S.VoiceGrantRenew,
    result: S.AgoraGrant,
    can: ["owner", "remote"],
  },
  {
    op: "voice.call.start",
    about: [],
    input: S.VoiceCallStart,
    result: S.VoiceCall,
    can: ["owner", "remote"],
  },
  {
    op: "voice.call.stop",
    about: [],
    input: S.VoiceCall,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "voice.call.hear",
    about: [],
    input: S.VoiceHeard,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "voice.call.say",
    about: [],
    input: S.VoiceSaid,
    result: undefined,
    can: ["owner", "remote"],
  },
  {
    op: "voice.dictate",
    about: [],
    input: S.DictateRequest,
    result: S.Dictated,
    can: ["owner", "remote"],
  },
];
