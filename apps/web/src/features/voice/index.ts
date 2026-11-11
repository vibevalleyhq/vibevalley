import { createExternal } from "#/base/external.ts";
import { voiceCall } from "#/features/voice/model/call.ts";

export { DictationBar, DictationButton, DictationKey, dictationKey, DictationProblem, useDictation } from "#/features/voice/views/DictationButton.tsx";
export { VoiceForm } from "#/features/voice/views/VoiceForm.tsx";
export { MossPlayground } from "#/features/voice/views/MossPlayground.tsx";
export { VoiceCall, voiceCall } from "#/features/voice/model/call.ts";
export { liveCaptions } from "#/features/voice/model/captions.ts";
export type { SpokenLine } from "#/features/voice/model/captions.ts";
export type { CallPhase } from "#/features/voice/model/call.ts";

/** The call as an accessor: the store counts its changes, so each read of the call goes through `version`. */
export function createCall() {
  const version = createExternal(voiceCall.subscribe, () => voiceCall.version);
  return () => (version(), voiceCall);
}
