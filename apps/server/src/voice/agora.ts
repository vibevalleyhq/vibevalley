import { t } from "@vibevalley/i18n";
import type { VoiceSettings } from "@vibevalley/protocol";
import type { VoiceUnavailable } from "@vibevalley/protocol/api";
import { alreadyStopping, clientOf, newChannel, newUid, type Run, retrying, sign, tokenSeconds } from "@vibevalley/provider/agora/server";

import { orchestratorModel } from "#/orchestrator/situation.ts";
import type { VoiceKeys } from "#/setting/setting.ts";

import {
  agentFor,
  buildVendors,
  type CallLine,
  CallStepFailed,
  callStepFailed,
  failed,
  speakPieces,
  unavailable,
  type VendorMessages,
  type Vendors,
  voiceAgentUid,
} from "./agora-vendors.ts";

export {
  agentFor,
  alreadyStopping,
  type CallLine,
  CallStepFailed,
  callStepFailed,
  clientOf,
  failed,
  newChannel,
  newUid,
  type Run,
  retrying,
  sign,
  speakPieces,
  tokenSeconds,
  unavailable,
  type Vendors,
  voiceAgentUid,
};

/** For a member added to the union and not to vendorsFor. */
export const voiceUnknown = () => t("server.voice.unknownSuffix");

const vendorMessages: VendorMessages = {
  noAsrKey: () => t("server.voice.noAsrKey"),
  noLine: () => t("server.voice.noLine"),
  noDeepseekKey: () => t("server.voice.noDeepseekKey"),
  noLlmKey: () => t("server.voice.noLlmKey"),
  noTtsKey: () => t("server.voice.noTtsKey"),
  unknownAsr: (vendor) => t("server.voice.unknown", { what: t("server.voice.part.asr"), vendor }),
  unknownLlm: (vendor) => t("server.voice.unknown", { what: t("server.voice.part.llm"), vendor }),
  unknownTts: (vendor) => t("server.voice.unknown", { what: t("server.voice.part.tts"), vendor }),
  unusable: (why) => t("server.voice.unusable", { why }),
};

/** The three vendors the voice page chose, or why they cannot be: a vendor whose key is missing. Agora-hosted ones need no key of their own. */
export function vendorsFor(voice: VoiceSettings, keys: VoiceKeys, deepseekKey: string, line?: CallLine): Vendors | VoiceUnavailable {
  return buildVendors(voice, keys, deepseekKey, vendorMessages, line, orchestratorModel);
}
