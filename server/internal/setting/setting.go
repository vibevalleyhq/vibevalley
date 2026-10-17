package setting

// settings.json is readable by you only (0600). A key saved here wins over the configuration (base.Config). Keys are asked
// for each time they are used, so one saved is used at once; pages see only where each comes from and its last characters; keys are never logged.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"

	"vibevalley/internal/base"
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

type Service struct {
	file string

	config struct{ deepseek, appID, certificate string }
	// 恢复默认 goes back to these.
	voiceDefaults protocol.VoiceSettings

	mu     sync.Mutex
	stored voiceStored
	disk   *base.FileWriter
}

func newService(cfg base.Config) (*Service, error) { return New(cfg), nil }

// settings.json in the home; the keys and the voice from cfg when the app has none.
func New(cfg base.Config) *Service {
	file := filepath.Join(cfg.Home, "settings.json")
	s := &Service{file: file, disk: base.NewFileWriter(file, 0o600)}
	s.config.deepseek = cfg.DeepSeek.APIKey
	s.config.appID = cfg.Agora.AppID
	s.config.certificate = cfg.Agora.AppCertificate
	s.voiceDefaults = protocol.DefaultVoice()
	if model := protocol.VoiceAnswerAgoraModel(cfg.Voice.Model); slices.Contains(protocol.VoiceAnswerAgoraModelValues, model) {
		s.voiceDefaults.Answer = protocol.VoiceAnswer{Value: protocol.VoiceAnswerAgora{Model: model}}
	}
	if id := cfg.Voice.ID; id != "" {
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

func (*Service) OnStart(context.Context) error { return nil }
func (*Service) OnStop()                       {}

func (s *Service) pick(stored, config string) (string, protocol.KeySource) {
	if stored != "" {
		return stored, protocol.KeySourceSettings
	}
	if config != "" {
		return config, protocol.KeySourceConfig
	}
	return "", ""
}

func voiceSecret(value string, source protocol.KeySource) protocol.KeyStatus {
	if value == "" {
		return protocol.KeyStatus{}
	}
	hint := keyHint(value)
	return protocol.KeyStatus{Source: &source, Hint: &hint}
}

func (s *Service) voiceOf(stored voiceStored) protocol.VoiceSettings {
	if stored.Voice == nil {
		return s.voiceDefaults
	}
	return voiceSettingsOver(s.voiceDefaults, *stored.Voice)
}

func (s *Service) Status() protocol.SettingsStatus {
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
	if key, source := s.pick(stored.DeepseekAPIKey, s.config.deepseek); key != "" {
		status.DeepseekAPIKey = voiceSecret(key, source)
	}
	if id, source := s.pick(stored.AgoraAppID, s.config.appID); id != "" {
		status.AgoraAppID = protocol.AgoraAppID{Source: &source, Value: &id}
	}
	if cert, source := s.pick(stored.AgoraAppCertificate, s.config.certificate); cert != "" {
		status.AgoraAppCertificate = voiceSecret(cert, source)
	}
	return status
}

// A key missing from the update is kept, an empty one cleared; the voice overrides replace the saved ones ({} goes back to the defaults). Nothing is
// saved when something cannot be right.
func (s *Service) Check(u protocol.SettingsUpdate) protocol.SettingsCheck {
	return protocol.SettingsCheck{Problem: settingsProblem(u)}
}

// The voice may come whole or as overrides: only what differs from the defaults is kept, so a default changed later still
// reaches what was left as it was.
func (s *Service) Save(u protocol.SettingsUpdate) (protocol.SettingsStatus, error) {
	if problem := settingsProblem(u); problem != "" {
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
		kept := voiceOverrides(s.voiceDefaults, voiceSettingsOver(s.voiceDefaults, *u.Voice))
		next.Voice = &kept
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

func (s *Service) DeepseekAPIKey() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	key, _ := s.pick(s.stored.DeepseekAPIKey, s.config.deepseek)
	return key
}

func (s *Service) Agora() *agora.Credentials {
	s.mu.Lock()
	defer s.mu.Unlock()
	id, _ := s.pick(s.stored.AgoraAppID, s.config.appID)
	cert, _ := s.pick(s.stored.AgoraAppCertificate, s.config.certificate)
	if id == "" || cert == "" {
		return nil
	}
	return &agora.Credentials{AppID: id, AppCertificate: cert}
}

func (s *Service) Voice() protocol.VoiceSettings {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.voiceOf(s.stored)
}

// Only ever from settings.json.
func (s *Service) VoiceKeys() VoiceKeys {
	s.mu.Lock()
	defer s.mu.Unlock()
	return VoiceKeys{ASRKey: s.stored.ASRKey, LLMKey: s.stored.LLMKey, TTSKey: s.stored.TTSKey}
}
