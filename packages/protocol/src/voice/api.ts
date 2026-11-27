import type { Endpoint } from "../endpoint";
import * as S from "../schema";
import type * as T from "../shapes";

export interface VoiceHandlers {
  /** Whether MOSS Live takes the key: a session is attached and closed again, nothing is said. */
  readonly "voice.moss.verify": () => Promise<T.Validation>;
}

export const voiceEndpoints: readonly Endpoint[] = [
  {
    op: "voice.moss.verify",
    about: [],
    input: undefined,
    result: S.Validation,
    can: ["user"],
  },
];
