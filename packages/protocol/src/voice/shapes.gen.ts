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
