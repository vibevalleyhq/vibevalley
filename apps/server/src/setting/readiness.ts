import { Array as Arr, Option } from "effect";

import type * as T from "@vibevalley/protocol";

import type { ProviderSettings } from "./provider.ts";

/** What the readiness of each feature is read from: the MOSS settings, and the keys and choices kept elsewhere. */
export interface ReadinessInput {
  readonly providers: ProviderSettings;
  readonly deepseekKey: boolean;
  readonly agora: boolean;
  readonly dictation: { readonly via: "moss" | "own"; readonly url: string };
  /** Who answers a call: MOSS Live needs its own binding, the others Agora's credentials. */
  readonly callAnswer: string;
}

const ready: T.Readiness = { ready: true };
const lacks = (missing: T.Missing): T.Readiness => ({ ready: false, missing });

type MossUse = "image" | "understanding" | "speech" | "speakers" | "voiceDesign" | "transcription" | "dictation" | "live" | "vision";

/** A MOSS use is ready with a bound connection that is turned on and has its key; what it lacks first is said first. */
const mossUse = (providers: ProviderSettings, use: MossUse): T.Readiness => {
  if (providers.connections.length === 0) return lacks("mossAccount");
  const binding = providers[use];
  const connection = binding === null ? Option.none() : Arr.findFirst(providers.connections, (c) => c.id === binding.connection);
  if (Option.isNone(connection)) return lacks("binding");
  if (!connection.value.enabled) return lacks("mossOff");
  return connection.value.key === "" ? lacks("mossKey") : ready;
};

/** Whether each feature has what it needs set up. It does not ask the remote services. */
export const readinessOf = (input: ReadinessInput): Record<T.Feature, T.Readiness> => {
  const moss = (use: MossUse) => mossUse(input.providers, use);
  const live = moss("live");
  return {
    orchestrator: input.deepseekKey ? ready : lacks("deepseekKey"),
    image: moss("image"),
    understanding: moss("understanding"),
    speech: moss("speech"),
    speakers: moss("speakers"),
    voiceDesign: moss("voiceDesign"),
    transcription: moss("transcription"),
    dictation: input.dictation.via === "own" ? (input.dictation.url === "" ? lacks("dictationUrl") : ready) : moss("dictation"),
    live,
    vision: moss("vision"),
    call: input.callAnswer === "moss" ? live : input.agora ? ready : lacks("agora"),
  };
};
