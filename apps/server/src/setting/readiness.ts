import type * as T from "@vibevalley/protocol";

import { bindingOf, type ProviderSettings, type Use } from "./provider.ts";

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

/** A MOSS use is ready as setting/provider.ts bindingOf says. */
const mossUse = (providers: ProviderSettings, use: Use): T.Readiness => {
  const bound = bindingOf(use)(providers);
  return bound.ready ? ready : lacks(bound.missing);
};

/** Whether each feature has what it needs set up. It does not ask the remote services. */
export const readinessOf = (input: ReadinessInput): Record<T.Feature, T.Readiness> => {
  const moss = (use: Use) => mossUse(input.providers, use);
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
