export * from "./shapes.gen";

/** The Settings section a call's problem is fixed in (VoiceUnavailable.settings): its address under /settings. */
export const VoiceFixValues = ["models", "call", "moss", "dictation"] as const;
export type VoiceFix = (typeof VoiceFixValues)[number];

/** A page's line to MOSS Live: a WebSocket the server relays to wss://api.mosi.cn/v1/realtime with the saved key. */
export const mossLinePath = "/api/v1/voice/moss/line";
export const visionLinePath = "/api/v1/voice/vision/line";

export const voiceSilenceMsMin = 200;

export const voiceSilenceMsMax = 2000;

export const voiceInterruptMsMin = 80;

export const voiceInterruptMsMax = 1000;

export const voiceIdleSecondsMin = 10;

export const voiceIdleSecondsMax = 600;
