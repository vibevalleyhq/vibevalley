package setting

import "vibevalley/internal/protocol"

type VoiceKeys struct {
	ASRKey string
	LLMKey string
	TTSKey string
}

// Read together, so an address is never paired with another one's key.
type DictationConfig struct {
	protocol.Dictation
	Key string
}

// VoiceConfig is one settings revision: provider selection and credentials belong together.
type VoiceConfig struct {
	Voice          protocol.VoiceSettings
	Keys           VoiceKeys
	DeepseekAPIKey string
}

// A memory source as settings.json keeps it, with its key: read together, so an address is never paired with another one's key.
type MemorySourceConfig struct {
	Kind       protocol.MemorySourceKind `json:"kind"`
	URL        string                    `json:"url"`
	Enabled    bool                      `json:"enabled,omitempty"`
	Read       bool                      `json:"read,omitempty"`
	Write      bool                      `json:"write,omitempty"`
	Everything bool                      `json:"everything,omitempty"`
	User       string                    `json:"user,omitempty"`
	Key        string                    `json:"key,omitempty"`
}
