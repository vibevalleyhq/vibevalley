package setting

import "vibevalley/internal/protocol"

type VoiceKeys struct {
	ASRKey string
	LLMKey string
	TTSKey string
}

// VoiceConfig is one settings revision: provider selection and credentials belong together.
type VoiceConfig struct {
	Voice          protocol.VoiceSettings
	Keys           VoiceKeys
	DeepseekAPIKey string
}
