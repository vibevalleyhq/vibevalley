import { t } from "@vibevalley/i18n";
import type * as T from "@vibevalley/protocol";
import { Secret } from "@vibevalley/protocol/schema";
import { mossImageModels } from "@vibevalley/provider/moss/image-models";
import { mossLiveModels } from "@vibevalley/provider/moss/live-models";
import { mossSpeakersModels } from "@vibevalley/provider/moss/speakers-models";
import { mossSpeechModels } from "@vibevalley/provider/moss/speech-models";
import { mossTranscriptionModels } from "@vibevalley/provider/moss/transcription-models";
import { mossUnderstandingModels } from "@vibevalley/provider/moss/understanding-models";
import { mossVisionModels } from "@vibevalley/provider/moss/vision-models";
import { mossVoiceDesignModels } from "@vibevalley/provider/moss/voice-design-models";
import { mossTranscription } from "@vibevalley/provider/transcription";

import { BizCode, bizError } from "#/base/errors.ts";
import { keyHint } from "#/platform/setting/memorySources.ts";
import { boundConnection, type ProviderSettings } from "#/platform/setting/provider.ts";

export const providerStatus = (settings: ProviderSettings): T.ProviderStatus => ({
  revision: settings.revision,
  connections: settings.connections.map(({ key, ...connection }) => ({
    ...connection,
    key: key.reveal() ? { source: "settings", hint: keyHint(key.reveal()) } : { source: null },
  })),
  dictation: settings.dictation ? { ...settings.dictation } : null,
  image: settings.image ? { ...settings.image } : null,
  live: settings.live ? { ...settings.live } : null,
  liveModels: [...mossLiveModels],
  speakers: settings.speakers ? { ...settings.speakers } : null,
  speakersModels: [...mossSpeakersModels],
  voiceDesign: settings.voiceDesign ? { ...settings.voiceDesign } : null,
  voiceDesignModels: [...mossVoiceDesignModels],
  transcription: settings.transcription ? { ...settings.transcription } : null,
  transcriptionModels: [...mossTranscriptionModels],
  vision: settings.vision ? { ...settings.vision } : null,
  visionModels: [...mossVisionModels],
  dictationModels: [...mossTranscription.models],
  imageModels: [...mossImageModels],
  understanding: settings.understanding ? { ...settings.understanding } : null,
  understandingModels: [...mossUnderstandingModels],
  speech: settings.speech ? { ...settings.speech } : null,
  speechModels: [...mossSpeechModels],
});

const refuse = (message: string) => bizError(BizCode.ProviderRefused, message);

/** The providers update lays over current; refused (thrown) when it cannot be right. */
export function connectionsOver(current: ProviderSettings, update: T.ProviderUpdate): ProviderSettings {
  if (update.revision !== current.revision) throw refuse(t("server.provider.changed"));
  if (update.connections.length > 32) throw refuse(t("server.provider.limit"));
  const seen = new Set<string>();
  const connections: ProviderSettings["connections"][number][] = [];
  for (const input of update.connections) {
    if (!/^[a-zA-Z0-9_-]{1,80}$/u.test(input.id) || seen.has(input.id)) throw refuse(t("server.provider.id"));
    seen.add(input.id);
    const name = input.name.trim();
    if (!name || name.length > 80) throw refuse(t("server.provider.name"));
    const kept = current.connections.find((c) => c.id === input.id)?.key;
    const key = input.key === undefined ? (kept === undefined ? "" : kept.reveal()) : input.key === null ? "" : input.key.trim();
    if ((input.key !== undefined && input.key !== null && key === "") || /\s/u.test(key) || key.length > 4096) throw refuse(t("server.provider.key"));
    connections.push({ id: input.id, name, adapter: input.adapter, enabled: input.enabled, key: new Secret(key) });
  }
  const next: ProviderSettings = {
    revision: current.revision + 1,
    connections,
    dictation: update.dictation,
    image: update.image,
    understanding: update.understanding,
    speech: update.speech,
    live: update.live,
    speakers: update.speakers,
    voiceDesign: update.voiceDesign,
    transcription: update.transcription,
    vision: update.vision,
  };
  if (
    (next.dictation && !boundConnection(next, next.dictation.connection)) ||
    (next.image && !boundConnection(next, next.image.connection)) ||
    (next.understanding && !boundConnection(next, next.understanding.connection)) ||
    (next.speech && !boundConnection(next, next.speech.connection)) ||
    (next.live && !boundConnection(next, next.live.connection)) ||
    (next.speakers && !boundConnection(next, next.speakers.connection)) ||
    (next.voiceDesign && !boundConnection(next, next.voiceDesign.connection)) ||
    (next.transcription && !boundConnection(next, next.transcription.connection)) ||
    (next.vision && !boundConnection(next, next.vision.connection))
  )
    throw refuse(t("server.provider.bound"));
  if (next.dictation && !mossTranscription.models.some((model) => model === next.dictation?.model)) throw refuse(t("server.provider.model"));
  if (next.image && !mossImageModels.some((model) => model === next.image?.model)) throw refuse(t("server.provider.imageModel"));
  if (next.understanding && !mossUnderstandingModels.some((model) => model === next.understanding?.model))
    throw refuse(t("server.provider.understandingModel"));
  if (next.speech && !mossSpeechModels.some((model) => model === next.speech?.model)) throw refuse(t("server.provider.speechModel"));
  for (const [use, models] of [
    ["live", mossLiveModels],
    ["speakers", mossSpeakersModels],
    ["voiceDesign", mossVoiceDesignModels],
    ["transcription", mossTranscriptionModels],
    ["vision", mossVisionModels],
  ] as const) {
    const binding = next[use];
    if (binding && !models.some((model) => model === binding.model))
      throw refuse(t("server.provider.capabilityModel", { capability: t(`server.provider.use.${use}`) }));
  }
  return next;
}
