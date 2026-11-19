export * from "./shapes.gen";

/** The Settings section a call's problem is fixed in (VoiceUnavailable.settings): its address under /settings. */
export const VoiceFixValues = ["models", "call", "moss", "dictation"] as const;
export type VoiceFix = (typeof VoiceFixValues)[number];

export const voiceSilenceMsMin = 200;

export const voiceSilenceMsMax = 2000;

export const voiceInterruptMsMin = 80;

export const voiceInterruptMsMax = 1000;

export const voiceIdleSecondsMin = 10;

export const voiceIdleSecondsMax = 600;
