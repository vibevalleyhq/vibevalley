// The call to the orchestrator as an accessor, for whatever shows it (the farm phone's line, 田头's head and its problem).

import { createExternal } from "@/base/external";

import { voiceCall } from "./call";

/** The call as an accessor: the store counts its changes, so each read of the call goes through `version`. */
export function createCall() {
  const version = createExternal(voiceCall.subscribe, () => voiceCall.version);
  return () => (version(), voiceCall);
}
