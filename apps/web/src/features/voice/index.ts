import { createExternal } from "#/base/external.ts";

import { voiceCall } from "./call";

export { DictationBar, DictationButton, DictationKey, dictationKey, DictationProblem, useDictation } from "./DictationButton";
export { VoiceForm } from "./VoiceForm";
export { MossPlayground } from "./MossPlayground";
export { VoiceCall, voiceCall } from "./call";
export { liveCaptions } from "./captions";
export type { SpokenLine } from "./captions";
export type { CallPhase } from "./call";

/** The call as an accessor: the store counts its changes, so each read of the call goes through `version`. */
export function createCall() {
  const version = createExternal(voiceCall.subscribe, () => voiceCall.version);
  return () => (version(), voiceCall);
}
