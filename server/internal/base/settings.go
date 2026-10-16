package base

// settings.json is readable by you only (0600). A key saved here wins over the environment, which wins over pi's own configuration. Keys are asked
// for each time they are used, so one saved is used at once; pages see only where each comes from and its last characters; keys are never logged.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/agora"
)

// The field order is the file's.
type voiceStored struct {
	DeepseekAPIKey      string                        `json:"deepseekApiKey,omitempty"`
	AgoraAppID          string                        `json:"agoraAppId,omitempty"`
	AgoraAppCertificate string                        `json:"agoraAppCertificate,omitempty"`
	ASRKey              string                        `json:"asrKey,omitempty"`
	LLMKey              string                        `json:"llmKey,omitempty"`
	TTSKey              string                        `json:"ttsKey,omitempty"`
	Voice               *protocol.SettingsUpdateVoice `json:"voice,omitempty"`
}

func voiceReadSettings(file string) voiceStored {
	var s voiceStored
	body, err := os.ReadFile(file)
	if err != nil {
		return voiceStored{}
	}
	if err := json.Unmarshal(body, &s); err != nil {
		return voiceStored{}
	}
	return s
}

// DEEPSEEK_API_KEY, $DEEPSEEK_API_KEY or ${DEEPSEEK_API_KEY}.
var voiceEnvName = regexp.MustCompile(`^\$?\{?([A-Z][A-Z0-9_]*)\}?$`)

func voicePiDeepseekKey(file string, getenv func(string) string) string {
	body, err := os.ReadFile(file)
	if err != nil {
		return ""
	}
	var models struct {
		Providers map[string]struct {
			APIKey string `json:"apiKey"`
		} `json:"providers"`
	}
	if json.Unmarshal(body, &models) != nil {
		return ""
	}
	key := models.Providers["deepseek"].APIKey
	if m := voiceEnvName.FindStringSubmatch(key); m != nil {
		return getenv(m[1])
	}
	return key
}

type Settings struct {
	file   string
	piFile string
	getenv func(string) string

	env struct{ deepseek, appID, certificate string }
	// 恢复默认 goes back to these.
	voiceDefaults protocol.VoiceSettings

	mu     sync.Mutex
	stored voiceStored
	disk   *FileWriter
}

func newSettings(cfg Config) (*Settings, error) {
	home, _ := os.UserHomeDir()
	return NewSettingsFrom(cfg.Home, filepath.Join(home, ".pi", "agent", "models.json"), os.Getenv), nil
}

func NewSettingsFrom(home, piFile string, getenv func(string) string) *Settings {
	file := filepath.Join(home, "settings.json")
	s := &Settings{file: file, piFile: piFile, getenv: getenv, disk: NewFileWriter(file, 0o600)}
	s.env.deepseek = getenv("DEEPSEEK_API_KEY")
	s.env.appID = getenv("AGORA_APP_ID")
	s.env.certificate = getenv("AGORA_APP_CERTIFICATE")
	s.voiceDefaults = protocol.DefaultVoice()
	if model := protocol.VoiceLLMAgoraModel(getenv("VIBEVALLEY_VOICE_MODEL")); slices.Contains(protocol.VoiceModels, model) {
		s.voiceDefaults.LLM = protocol.VoiceLLM{Value: protocol.VoiceLLMAgora{Model: model}}
	}
	if id := getenv("VIBEVALLEY_VOICE_ID"); id != "" {
		// The default voice's model when it is MiniMax's, else MiniMax's turbo.
		model := protocol.VoiceTTSMinimaxModelSpeech26Turbo
		if m, ok := protocol.DefaultVoice().TTS.Value.(protocol.VoiceTTSMinimax); ok {
			model = m.Model
		}
		s.voiceDefaults.TTS = protocol.VoiceTTS{Value: protocol.VoiceTTSMinimax{Model: model, VoiceID: id}}
	}
	s.stored = voiceReadSettings(file)
	return s
}

func (*Settings) OnStart(context.Context) error { return nil }
func (*Settings) OnStop()                       {}

func (s *Settings) pick(stored, env string) (string, protocol.KeySource) {
	if stored != "" {
		return stored, protocol.KeySourceSettings
	}
	if env != "" {
		return env, protocol.KeySourceEnv
	}
	return "", ""
}

func voiceSecret(value string, source protocol.KeySource) protocol.KeyStatus {
	if value == "" {
		return protocol.KeyStatus{}
	}
	hint := protocol.KeyHint(value)
	return protocol.KeyStatus{Source: &source, Hint: &hint}
}

func (s *Settings) voiceOf(stored voiceStored) protocol.VoiceSettings {
	if stored.Voice == nil {
		return s.voiceDefaults
	}
	return protocol.VoiceSettingsOver(s.voiceDefaults, *stored.Voice)
}

func (s *Settings) Status() protocol.SettingsStatus {
	s.mu.Lock()
	stored := s.stored
	s.mu.Unlock()
	status := protocol.SettingsStatus{
		File:          s.file,
		Voice:         s.voiceOf(stored),
		VoiceDefaults: s.voiceDefaults,
		ASRKey:        voiceSecret(stored.ASRKey, protocol.KeySourceSettings),
		LLMKey:        voiceSecret(stored.LLMKey, protocol.KeySourceSettings),
		TTSKey:        voiceSecret(stored.TTSKey, protocol.KeySourceSettings),
	}
	if key, source := s.pick(stored.DeepseekAPIKey, s.env.deepseek); key != "" {
		status.DeepseekAPIKey = voiceSecret(key, source)
	} else if pi := voicePiDeepseekKey(s.piFile, s.getenv); pi != "" {
		status.DeepseekAPIKey = voiceSecret(pi, protocol.KeySourcePi)
	}
	if id, source := s.pick(stored.AgoraAppID, s.env.appID); id != "" {
		status.AgoraAppID = protocol.AgoraAppID{Source: &source, Value: &id}
	}
	if cert, source := s.pick(stored.AgoraAppCertificate, s.env.certificate); cert != "" {
		status.AgoraAppCertificate = voiceSecret(cert, source)
	}
	return status
}

// A key missing from the update is kept, an empty one cleared; the voice overrides replace the saved ones ({} goes back to the defaults). Nothing is
// saved when something cannot be right.
func (s *Settings) Save(u protocol.SettingsUpdate) (protocol.SettingsStatus, error) {
	if problem := protocol.SettingsProblem(u); problem != "" {
		return protocol.SettingsStatus{}, fmt.Errorf("%s", problem)
	}
	s.mu.Lock()
	next := s.stored
	given := func(field *string, update *string) {
		if update != nil {
			*field = strings.TrimSpace(*update)
		}
	}
	given(&next.DeepseekAPIKey, u.DeepseekAPIKey)
	given(&next.AgoraAppID, u.AgoraAppID)
	given(&next.AgoraAppCertificate, u.AgoraAppCertificate)
	given(&next.ASRKey, u.ASRKey)
	given(&next.LLMKey, u.LLMKey)
	given(&next.TTSKey, u.TTSKey)
	if u.Voice != nil {
		next.Voice = u.Voice
	}
	if next.Voice != nil {
		if body, _ := json.Marshal(next.Voice); string(body) == "{}" {
			next.Voice = nil
		}
	}
	s.mu.Unlock()
	err := s.disk.Write(func() ([]byte, error) {
		body, err := json.MarshalIndent(next, "", "  ")
		return append(body, '\n'), err
	})
	if err != nil {
		return protocol.SettingsStatus{}, fmt.Errorf("存不进 %s：%v", s.file, err)
	}
	s.mu.Lock()
	s.stored = next
	s.mu.Unlock()
	return s.Status(), nil
}

func (s *Settings) DeepseekAPIKey() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	key, _ := s.pick(s.stored.DeepseekAPIKey, s.env.deepseek)
	return key
}

func (s *Settings) VoiceDeepseekKey() string {
	if key := s.DeepseekAPIKey(); key != "" {
		return key
	}
	return voicePiDeepseekKey(s.piFile, s.getenv)
}

func (s *Settings) Agora() *agora.Credentials {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, _ := s.pick(s.stored.AgoraAppID, s.env.appID)
	cert, _ := s.pick(s.stored.AgoraAppCertificate, s.env.certificate)
	if id == "" || cert == "" {
		return nil
	}
	return &agora.Credentials{AppID: id, AppCertificate: cert}
}

func (s *Settings) Voice() protocol.VoiceSettings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.voiceOf(s.stored)
}

// Only ever from settings.json.
func (s *Settings) VoiceKeys() VoiceKeys {
	s.mu.Lock()
	defer s.mu.Unlock()
	return VoiceKeys{ASRKey: s.stored.ASRKey, LLMKey: s.stored.LLMKey, TTSKey: s.stored.TTSKey}
}
