import { z } from "zod";

import { type Endpoint, input } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface VoiceHandlers {
  /** A line heard on the call that is on, without its id: refused unless one call is. */
  readonly "voice.hear": (a: { readonly text: string; readonly agent?: string; readonly sendKey?: string }) => Promise<void>;
  readonly "voice.grant.create": () => Promise<T.AgoraGrant>;
  readonly "voice.grant.renew": (a: T.VoiceGrantRenew) => Promise<T.AgoraGrant>;
  readonly "voice.call.start": (a: T.VoiceCallStart) => Promise<T.VoiceCall>;
  readonly "voice.call.stop": (a: T.VoiceCall) => Promise<void>;
  readonly "voice.call.hear": (a: T.VoiceHeard) => Promise<void>;
  readonly "voice.call.say": (a: T.VoiceSaid) => Promise<void>;
  readonly "voice.dictate": (a: T.DictateRequest) => Promise<T.Dictated>;
  /** Whether MOSS Live takes the key: a session is attached and closed again, nothing is said. */
  readonly "voice.moss.verify": () => Promise<T.Validation>;
}

export const voiceEndpoints: readonly Endpoint[] = [
  {
    op: "voice.hear",
    about: [],
    input: input({ text: z.string(), agent: z.exactOptional(z.string()), sendKey: z.exactOptional(z.string()) }),
    result: undefined,
    can: ["user", "remote"],
  },
  {
    op: "voice.moss.verify",
    about: [],
    input: undefined,
    result: S.Validation,
    can: ["user"],
  },
  {
    op: "voice.grant.create",
    about: [],
    input: undefined,
    result: S.AgoraGrant,
    can: ["user", "remote"],
  },
  {
    op: "voice.grant.renew",
    about: [],
    input: S.VoiceGrantRenew,
    result: S.AgoraGrant,
    can: ["user", "remote"],
  },
  {
    op: "voice.call.start",
    about: [],
    input: S.VoiceCallStart,
    result: S.VoiceCall,
    can: ["user", "remote"],
  },
  {
    op: "voice.call.stop",
    about: [],
    input: S.VoiceCall,
    result: undefined,
    can: ["user", "remote"],
  },
  {
    op: "voice.call.hear",
    about: [],
    input: S.VoiceHeard,
    result: undefined,
    can: ["user", "remote"],
  },
  {
    op: "voice.call.say",
    about: [],
    input: S.VoiceSaid,
    result: undefined,
    can: ["user", "remote"],
  },
  {
    op: "voice.dictate",
    about: [],
    input: S.DictateRequest,
    result: S.Dictated,
    can: ["user", "remote"],
  },
];
