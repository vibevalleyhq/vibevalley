// Generated from crates/protocol/src/contract (vp run protocol:ts). Do not edit.

export const CallStateValues = ["idle", "connecting", "live", "ending", "error"] as const;
export type CallState = (typeof CallStateValues)[number];

export type FactCallChanged = { "type": "callChanged", at: number, state: CallState, reason: string, };

export type VoiceCall = { agentId: string, };

export type VoiceGrant = { channel: string, uid: string, };

export type VoiceSettings = { persona: string, greeting: string, };

/**
 * A change to the voice settings: the keys it names.
 */
export type SettingsUpdateVoice = { persona?: string, greeting?: string, };

export type VoiceSaid = { agentId: string, text: string, };

export type VoiceHeard = { agentId: string, text: string,
/**
 * The profile the user picked; absent for none.
 */
agent?: string, sendKey?: string, };

export type VoiceCallStart = { channel: string, uid: string,
/**
 * The call answers a ring: what rang, which the orchestrator says first instead of the greeting.
 */
about?: string, };

export type VoiceHearInput = { text: string, agent?: string, sendKey?: string, };

/**
 * Credentials identifying an active server-tracked ASR dictation session.
 */
export type VoiceAsrGrant = { sessionId: string, model: string, };

export type VoiceAsrStopInput = { sessionId: string, };

/**
 * WAV audio payload submitted for one-shot MOSS transcription (`voice.asr.transcribe`).
 */
export type VoiceAsrTranscribeInput = { wavBase64: string, sessionId?: string, };

export type VoiceAsrResult = { text: string, };
