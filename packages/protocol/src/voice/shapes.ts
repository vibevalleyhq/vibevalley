export * from "./shapes.gen";

/** The Settings section a call's problem is fixed in (VoiceUnavailable.settings): its address under /settings. */
export const VoiceFixValues = ["models", "moss"] as const;
export type VoiceFix = (typeof VoiceFixValues)[number];
