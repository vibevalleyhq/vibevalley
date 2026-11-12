import type { VoiceHandlers } from "@vibevalley/protocol/api";

import type { Voice } from "#/gateway/voice/voice.ts";

export function voiceHandlers(deps: { readonly voice: Voice }): VoiceHandlers {
  const { voice } = deps;
  return {
    "voice.grant.create": () => voice.session(),
    "voice.grant.renew": (body) => voice.renew(body.channel, body.uid),
    "voice.call.start": (body) => voice.start(body.channel, body.uid, body.about),
    "voice.call.stop": (body) => voice.stop(body.agentId),
    "voice.call.hear": (body) => voice.heard(body.agentId, body.text, body.agent ?? "", body.sendKey ?? ""),
    "voice.call.say": (body) => voice.said(body.agentId, body.text),
    "voice.dictate": (body) => voice.dictate(body.audio, body.format),
    "voice.moss.verify": () => voice.verifyMoss(),
    "voice.hear": (body) => voice.heardCurrent(body.text, body.agent ?? "", body.sendKey ?? ""),
  };
}
