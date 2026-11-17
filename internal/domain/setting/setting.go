package setting

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"

	"github.com/vibevalleyhq/vibevalley/internal/config"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
)

const (
	settingsFileName   = "settings.json"
	mossBaseURL        = "https://api.mosi.cn/v1"
	maxConnections     = 32
	voiceSilenceMin    = 200
	voiceSilenceMax    = 2000
	voiceInterruptMin  = 80
	voiceInterruptMax  = 1000
	voiceIdleMin       = 10
	voiceIdleMax       = 600
	maxProviderKeyLen  = 4096
	maxResponseBodyLen = 1 << 20
)

var (
	// ErrSettingRefused indicates invalid settings input or persistence refusal.
	ErrSettingRefused = errors.New("setting: refused")
	// ErrProviderRefused indicates invalid provider update, stale revision, or remote listing error.
	ErrProviderRefused = errors.New("setting: provider refused")

	agoraHexRe   = regexp.MustCompile(`^[0-9a-fA-F]{32}$`)
	connIDRe     = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,80}$`)
	httpURLRe    = regexp.MustCompile(`^https?://\S+$`)
	whitespaceRe = regexp.MustCompile(`\s`)
)

// KeyCheckFunc validates a provider API key during Validate when provided in Options.
type KeyCheckFunc func(ctx context.Context, provider, apiKey string) error

// Options configures a settings Service.
type Options struct {
	HomeDir    string
	AppConfig  *config.AppConfig
	Getenv     func(string) string
	Clock      store.Clock
	Version    string
	KeyChecker KeyCheckFunc
	HTTPClient *http.Client
	MOSSBase   string
}

// KeyStatus matches packages/protocol/src/common/shapes.ts KeyStatus (never exposes raw secrets).
type KeyStatus struct {
	Source *string `json:"source"`
	Hint   string  `json:"hint,omitempty"`
}

// AgoraAppID matches packages/protocol/src/voice/shapes.ts AgoraAppID.
type AgoraAppID struct {
	Source *string `json:"source"`
	Value  string  `json:"value,omitempty"`
}

// SpacePaths matches packages/protocol/src/setting/shapes.ts SpacePaths.
type SpacePaths struct {
	Repos     string `json:"repos"`
	Worktrees string `json:"worktrees"`
	PKM       string `json:"pkm"`
}

// Readiness matches packages/protocol/src/setting/shapes.ts Readiness.
type Readiness struct {
	Ready   bool   `json:"ready"`
	Missing string `json:"missing,omitempty"`
}

// Dictation matches packages/protocol/src/voice/shapes.ts Dictation.
type Dictation struct {
	Via   string `json:"via"`
	URL   string `json:"url"`
	Model string `json:"model"`
}

// DictationConfig is the resolved server-side dictation configuration.
type DictationConfig struct {
	Via   string
	URL   string
	Model string
	Key   string
}

// VoiceASR matches packages/protocol/src/voice/shapes.ts VoiceASR.
type VoiceASR struct {
	Vendor string `json:"vendor"`
	Model  string `json:"model,omitempty"`
	Region string `json:"region,omitempty"`
}

// VoiceAnswer matches packages/protocol/src/voice/shapes.ts VoiceAnswer.
type VoiceAnswer struct {
	Vendor string `json:"vendor"`
	Model  string `json:"model,omitempty"`
	URL    string `json:"url,omitempty"`
}

// VoiceTTS matches packages/protocol/src/voice/shapes.ts VoiceTTS.
type VoiceTTS struct {
	Vendor    string `json:"vendor"`
	Model     string `json:"model,omitempty"`
	VoiceID   string `json:"voiceId,omitempty"`
	Voice     string `json:"voice,omitempty"`
	Region    string `json:"region,omitempty"`
	VoiceName string `json:"voiceName,omitempty"`
}

// VoiceSettings matches packages/protocol/src/voice/shapes.ts VoiceSettings.
type VoiceSettings struct {
	Area           string      `json:"area"`
	Language       string      `json:"language"`
	ASR            VoiceASR    `json:"asr"`
	Answer         VoiceAnswer `json:"answer"`
	TTS            VoiceTTS    `json:"tts"`
	Persona        string      `json:"persona"`
	Greeting       string      `json:"greeting"`
	FailureMessage string      `json:"failureMessage"`
	SilenceMs      int         `json:"silenceMs"`
	InterruptMs    int         `json:"interruptMs"`
	IdleSeconds    int         `json:"idleSeconds"`
}

// VoicePatch carries optional fields for updating VoiceSettings.
type VoicePatch struct {
	Area           *string      `json:"area,omitempty"`
	Language       *string      `json:"language,omitempty"`
	ASR            *VoiceASR    `json:"asr,omitempty"`
	Answer         *VoiceAnswer `json:"answer,omitempty"`
	TTS            *VoiceTTS    `json:"tts,omitempty"`
	Persona        *string      `json:"persona,omitempty"`
	Greeting       *string      `json:"greeting,omitempty"`
	FailureMessage *string      `json:"failureMessage,omitempty"`
	SilenceMs      *int         `json:"silenceMs,omitempty"`
	InterruptMs    *int         `json:"interruptMs,omitempty"`
	IdleSeconds    *int         `json:"idleSeconds,omitempty"`
}

// MemorySource matches packages/protocol/src/setting/shapes.ts MemorySource.
type MemorySource struct {
	Kind       string    `json:"kind"`
	URL        string    `json:"url"`
	Enabled    bool      `json:"enabled"`
	Read       bool      `json:"read"`
	Write      bool      `json:"write"`
	Everything bool      `json:"everything"`
	User       string    `json:"user,omitempty"`
	Key        KeyStatus `json:"key"`
}

// MemorySourceUpdate matches packages/protocol/src/setting/shapes.ts MemorySourceUpdate.
type MemorySourceUpdate struct {
	Kind       string  `json:"kind"`
	URL        string  `json:"url"`
	Enabled    bool    `json:"enabled"`
	Read       bool    `json:"read"`
	Write      bool    `json:"write"`
	Everything *bool   `json:"everything,omitempty"`
	User       *string `json:"user,omitempty"`
	Key        *string `json:"key,omitempty"`
}

// SettingsStatus matches packages/protocol/src/setting/shapes.ts SettingsStatus.
type SettingsStatus struct {
	File                string               `json:"file"`
	Home                string               `json:"home"`
	WorkRoot            string               `json:"workRoot,omitempty"`
	Paths               SpacePaths           `json:"paths"`
	Version             string               `json:"version"`
	Locale              string               `json:"locale"`
	DeepseekAPIKey      KeyStatus            `json:"deepseekApiKey"`
	AnthropicAPIKey     KeyStatus            `json:"anthropicApiKey"`
	OpenAIAPIKey        KeyStatus            `json:"openaiApiKey"`
	AgoraAppID          AgoraAppID           `json:"agoraAppId"`
	AgoraAppCertificate KeyStatus            `json:"agoraAppCertificate"`
	Voice               VoiceSettings        `json:"voice"`
	VoiceDefaults       VoiceSettings        `json:"voiceDefaults"`
	ASRKey              KeyStatus            `json:"asrKey"`
	LLMKey              KeyStatus            `json:"llmKey"`
	TTSKey              KeyStatus            `json:"ttsKey"`
	Dictation           Dictation            `json:"dictation"`
	DictationKey        KeyStatus            `json:"dictationKey"`
	Readiness           map[string]Readiness `json:"readiness"`
	MemorySources       []MemorySource       `json:"memorySources"`
}

// SettingsUpdate matches packages/protocol/src/setting/shapes.ts SettingsUpdate.
type SettingsUpdate struct {
	Locale              *string              `json:"locale,omitempty"`
	WorkRoot            *string              `json:"workRoot,omitempty"`
	DeepseekAPIKey      *string              `json:"deepseekApiKey,omitempty"`
	AnthropicAPIKey     *string              `json:"anthropicApiKey,omitempty"`
	OpenAIAPIKey        *string              `json:"openaiApiKey,omitempty"`
	AgoraAppID          *string              `json:"agoraAppId,omitempty"`
	AgoraAppCertificate *string              `json:"agoraAppCertificate,omitempty"`
	Voice               *VoicePatch          `json:"voice,omitempty"`
	ASRKey              *string              `json:"asrKey,omitempty"`
	LLMKey              *string              `json:"llmKey,omitempty"`
	TTSKey              *string              `json:"ttsKey,omitempty"`
	Dictation           *Dictation           `json:"dictation,omitempty"`
	DictationKey        *string              `json:"dictationKey,omitempty"`
	MemorySources       []MemorySourceUpdate `json:"memorySources,omitempty"`
}

// Validation matches packages/protocol/src/common/shapes.ts Validation.
type Validation struct {
	Problem string `json:"problem"`
}

// ProviderModel matches packages/protocol/src/provider/shapes.ts ProviderModel.
type ProviderModel struct {
	ID    string `json:"id"`
	Owner string `json:"owner"`
}

// ProviderConnection matches packages/protocol/src/provider/shapes.ts ProviderConnection.
type ProviderConnection struct {
	ID      string    `json:"id"`
	Name    string    `json:"name"`
	Adapter string    `json:"adapter"`
	Enabled bool      `json:"enabled"`
	Key     KeyStatus `json:"key"`
}

// ProviderBinding matches packages/protocol/src/provider/shapes.ts ProviderBinding.
type ProviderBinding struct {
	Connection string `json:"connection"`
	Model      string `json:"model"`
}

// ProviderStatus matches packages/protocol/src/provider/shapes.ts ProviderStatus.
type ProviderStatus struct {
	Revision            int                  `json:"revision"`
	Connections         []ProviderConnection `json:"connections"`
	Dictation           *ProviderBinding     `json:"dictation"`
	Image               *ProviderBinding     `json:"image"`
	Live                *ProviderBinding     `json:"live"`
	LiveModels          []string             `json:"liveModels"`
	Speakers            *ProviderBinding     `json:"speakers"`
	SpeakersModels      []string             `json:"speakersModels"`
	VoiceDesign         *ProviderBinding     `json:"voiceDesign"`
	VoiceDesignModels   []string             `json:"voiceDesignModels"`
	Transcription       *ProviderBinding     `json:"transcription"`
	TranscriptionModels []string             `json:"transcriptionModels"`
	Vision              *ProviderBinding     `json:"vision"`
	VisionModels        []string             `json:"visionModels"`
	DictationModels     []string             `json:"dictationModels"`
	ImageModels         []string             `json:"imageModels"`
	Understanding       *ProviderBinding     `json:"understanding"`
	UnderstandingModels []string             `json:"understandingModels"`
	Speech              *ProviderBinding     `json:"speech"`
	SpeechModels        []string             `json:"speechModels"`
}

// ProviderConnectionUpdate matches packages/protocol/src/provider/shapes.ts ProviderConnectionUpdate.
// Key == nil keeps the stored credential; *Key == "" clears it; non-empty replaces it.
// To support JSON `key: null` clearing explicitly, ClearKey can also be set or Key set to "".
type ProviderConnectionUpdate struct {
	ID       string  `json:"id"`
	Name     string  `json:"name"`
	Adapter  string  `json:"adapter"`
	Enabled  bool    `json:"enabled"`
	Key      *string `json:"key,omitempty"`
	ClearKey bool    `json:"-"`
}

// UnmarshalJSON distinguishes omitted "key" from explicit `"key": null` matching TS ProviderConnectionUpdate.
func (u *ProviderConnectionUpdate) UnmarshalJSON(data []byte) error {
	var raw struct {
		ID      string          `json:"id"`
		Name    string          `json:"name"`
		Adapter string          `json:"adapter"`
		Enabled bool            `json:"enabled"`
		Key     json.RawMessage `json:"key"`
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return err
	}
	u.ID = raw.ID
	u.Name = raw.Name
	u.Adapter = raw.Adapter
	u.Enabled = raw.Enabled
	if len(raw.Key) > 0 {
		if string(raw.Key) == "null" {
			u.ClearKey = true
		} else {
			var s string
			if err := json.Unmarshal(raw.Key, &s); err != nil {
				return err
			}
			u.Key = &s
		}
	}
	return nil
}

// ProviderUpdate matches packages/protocol/src/provider/shapes.ts ProviderUpdate.
type ProviderUpdate struct {
	Revision      int                        `json:"revision"`
	Connections   []ProviderConnectionUpdate `json:"connections"`
	Speech        *ProviderBinding           `json:"speech"`
	Understanding *ProviderBinding           `json:"understanding"`
	Dictation     *ProviderBinding           `json:"dictation"`
	Image         *ProviderBinding           `json:"image"`
	Live          *ProviderBinding           `json:"live"`
	Speakers      *ProviderBinding           `json:"speakers"`
	VoiceDesign   *ProviderBinding           `json:"voiceDesign"`
	Transcription *ProviderBinding           `json:"transcription"`
	Vision        *ProviderBinding           `json:"vision"`
}

// ProviderModelRequest matches packages/protocol/src/provider/shapes.ts ProviderModelRequest.
type ProviderModelRequest struct {
	Connection string `json:"connection"`
	Revision   int    `json:"revision"`
}

// ProviderVoiceRequest matches packages/protocol/src/provider/shapes.ts ProviderVoiceRequest.
type ProviderVoiceRequest struct {
	Connection string `json:"connection"`
	Revision   int    `json:"revision"`
	Limit      *int   `json:"limit,omitempty"`
	Offset     *int   `json:"offset,omitempty"`
	After      string `json:"after,omitempty"`
	Status     string `json:"status,omitempty"`
}

// ProviderVoice describes a cloned or listed vendor voice.
type ProviderVoice struct {
	ID               string `json:"id"`
	Name             string `json:"name"`
	CreatedAtSeconds int64  `json:"createdAtSeconds"`
}

// ProviderVoiceListing matches packages/protocol/src/provider/shapes.ts ProviderVoiceListing.
type ProviderVoiceListing struct {
	Connection string          `json:"connection"`
	Revision   int             `json:"revision"`
	Voices     []ProviderVoice `json:"voices"`
	HasMore    bool            `json:"hasMore"`
	NextCursor *string         `json:"nextCursor"`
}

// ProviderModelListing matches packages/protocol/src/provider/shapes.ts ProviderModelListing.
type ProviderModelListing struct {
	Connection string          `json:"connection"`
	Revision   int             `json:"revision"`
	Models     []ProviderModel `json:"models"`
}

type storedMemorySource struct {
	Kind       string `json:"kind"`
	URL        string `json:"url"`
	Enabled    bool   `json:"enabled,omitempty"`
	Read       bool   `json:"read,omitempty"`
	Write      bool   `json:"write,omitempty"`
	Everything bool   `json:"everything,omitempty"`
	User       string `json:"user,omitempty"`
	Key        string `json:"key,omitempty"`
}

type storedConnection struct {
	ID      string `json:"id"`
	Name    string `json:"name"`
	Adapter string `json:"adapter"`
	Enabled bool   `json:"enabled"`
	Key     string `json:"key"`
}

type storedProviders struct {
	Revision      int                `json:"revision"`
	Connections   []storedConnection `json:"connections"`
	Dictation     *ProviderBinding   `json:"dictation"`
	Image         *ProviderBinding   `json:"image"`
	Speech        *ProviderBinding   `json:"speech"`
	Understanding *ProviderBinding   `json:"understanding"`
	Live          *ProviderBinding   `json:"live"`
	Speakers      *ProviderBinding   `json:"speakers"`
	VoiceDesign   *ProviderBinding   `json:"voiceDesign"`
	Transcription *ProviderBinding   `json:"transcription"`
	Vision        *ProviderBinding   `json:"vision"`
}

func (p storedProviders) bindingFor(use string) *ProviderBinding {
	switch use {
	case "dictation":
		return p.Dictation
	case "image":
		return p.Image
	case "speech":
		return p.Speech
	case "understanding":
		return p.Understanding
	case "live":
		return p.Live
	case "speakers":
		return p.Speakers
	case "voiceDesign":
		return p.VoiceDesign
	case "transcription":
		return p.Transcription
	case "vision":
		return p.Vision
	default:
		return nil
	}
}

func (p storedProviders) findConnection(id string) (storedConnection, bool) {
	for _, c := range p.Connections {
		if c.ID == id {
			return c, true
		}
	}
	return storedConnection{}, false
}

func (p storedProviders) boundConnection(id string) (storedConnection, bool) {
	for _, c := range p.Connections {
		if c.ID == id && c.Enabled && c.Key != "" {
			return c, true
		}
	}
	return storedConnection{}, false
}

type storedDictation struct {
	Via   string `json:"via,omitempty"`
	URL   string `json:"url"`
	Model string `json:"model"`
}

type storedSettings struct {
	Locale              string               `json:"locale,omitempty"`
	WorkRoot            string               `json:"workRoot,omitempty"`
	DeepseekAPIKey      string               `json:"deepseekApiKey,omitempty"`
	AnthropicAPIKey     string               `json:"anthropicApiKey,omitempty"`
	OpenAIAPIKey        string               `json:"openaiApiKey,omitempty"`
	AgoraAppID          string               `json:"agoraAppId,omitempty"`
	AgoraAppCertificate string               `json:"agoraAppCertificate,omitempty"`
	ASRKey              string               `json:"asrKey,omitempty"`
	LLMKey              string               `json:"llmKey,omitempty"`
	TTSKey              string               `json:"ttsKey,omitempty"`
	Voice               *VoicePatch          `json:"voice,omitempty"`
	DictationKey        string               `json:"dictationKey,omitempty"`
	Dictation           *storedDictation     `json:"dictation,omitempty"`
	Providers           *storedProviders     `json:"providers,omitempty"`
	MemorySources       []storedMemorySource `json:"memorySources,omitempty"`
}

// Service manages VibeValley user settings, secret masking, priority resolution, and provider catalogs.
type Service struct {
	homeDir    string
	filePath   string
	appCfg     *config.AppConfig
	getenv     func(string) string
	clock      store.Clock
	version    string
	keyChecker KeyCheckFunc
	httpClient *http.Client
	mossBase   string

	mu     sync.RWMutex
	stored storedSettings
}

// NewService creates a settings Service, loading $VIBEVALLEY_HOME/settings.json if homeDir is non-empty.
func NewService(opts Options) (*Service, error) {
	homeDir := strings.TrimSpace(opts.HomeDir)
	if homeDir == "" && opts.AppConfig != nil {
		homeDir = strings.TrimSpace(opts.AppConfig.HomeDir)
	}
	getenv := opts.Getenv
	if getenv == nil {
		getenv = os.Getenv
	}
	clk := opts.Clock
	if clk == nil {
		clk = store.RealClock{}
	}
	version := strings.TrimSpace(opts.Version)
	if version == "" {
		version = "0.1.0"
	}
	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	mossBase := strings.TrimRight(strings.TrimSpace(opts.MOSSBase), "/")
	if mossBase == "" {
		mossBase = mossBaseURL
	}

	s := &Service{
		homeDir:    homeDir,
		appCfg:     opts.AppConfig,
		getenv:     getenv,
		clock:      clk,
		version:    version,
		keyChecker: opts.KeyChecker,
		httpClient: httpClient,
		mossBase:   mossBase,
	}
	if homeDir != "" {
		s.filePath = filepath.Join(homeDir, settingsFileName)
		if err := s.loadFromDisk(); err != nil {
			return nil, err
		}
	}
	return s, nil
}

// FilePath returns the path to settings.json, or "" in memory-only mode.
func (s *Service) FilePath() string { return s.filePath }

// Status returns the merged SettingsStatus with all secrets masked.
func (s *Service) Status() SettingsStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.statusLocked()
}

// Get is an alias for Status.
func (s *Service) Get() SettingsStatus {
	return s.Status()
}

// Validate validates a proposed SettingsUpdate without persisting changes.
func (s *Service) Validate(ctx context.Context, u SettingsUpdate) Validation {
	if problem := settingsProblem(u); problem != "" {
		return Validation{Problem: problem}
	}
	if s.keyChecker != nil {
		checks := []struct {
			provider string
			val      *string
		}{
			{"deepseek", u.DeepseekAPIKey},
			{"anthropic", u.AnthropicAPIKey},
			{"openai", u.OpenAIAPIKey},
			{"agora", u.AgoraAppCertificate},
		}
		for _, c := range checks {
			if c.val == nil {
				continue
			}
			trimmed := strings.TrimSpace(*c.val)
			if trimmed == "" {
				continue
			}
			if err := s.keyChecker(ctx, c.provider, trimmed); err != nil {
				return Validation{Problem: err.Error()}
			}
		}
	}
	return Validation{}
}

// Update validates and atomically persists a SettingsUpdate, returning the updated SettingsStatus.
func (s *Service) Update(ctx context.Context, u SettingsUpdate) (SettingsStatus, error) {
	if err := ctx.Err(); err != nil {
		return SettingsStatus{}, err
	}
	if problem := settingsProblem(u); problem != "" {
		return SettingsStatus{}, fmt.Errorf("%w: %s", ErrSettingRefused, problem)
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	next := cloneStoredSettings(s.stored)

	if u.Locale != nil {
		loc := strings.TrimSpace(*u.Locale)
		if loc == "zh" || loc == "" {
			next.Locale = ""
		} else {
			next.Locale = loc
		}
	}
	if u.WorkRoot != nil {
		next.WorkRoot = strings.TrimSpace(*u.WorkRoot)
	}
	if u.DeepseekAPIKey != nil {
		next.DeepseekAPIKey = strings.TrimSpace(*u.DeepseekAPIKey)
	}
	if u.AnthropicAPIKey != nil {
		next.AnthropicAPIKey = strings.TrimSpace(*u.AnthropicAPIKey)
	}
	if u.OpenAIAPIKey != nil {
		next.OpenAIAPIKey = strings.TrimSpace(*u.OpenAIAPIKey)
	}
	if u.AgoraAppID != nil {
		next.AgoraAppID = strings.TrimSpace(*u.AgoraAppID)
	}
	if u.AgoraAppCertificate != nil {
		next.AgoraAppCertificate = strings.TrimSpace(*u.AgoraAppCertificate)
	}
	if u.ASRKey != nil {
		next.ASRKey = strings.TrimSpace(*u.ASRKey)
	}
	if u.LLMKey != nil {
		next.LLMKey = strings.TrimSpace(*u.LLMKey)
	}
	if u.TTSKey != nil {
		next.TTSKey = strings.TrimSpace(*u.TTSKey)
	}
	if u.DictationKey != nil {
		next.DictationKey = strings.TrimSpace(*u.DictationKey)
	}
	if u.Dictation != nil {
		via := ""
		if u.Dictation.Via == "own" {
			via = "own"
		}
		cleanURL := strings.TrimRight(strings.TrimSpace(u.Dictation.URL), "/")
		model := strings.TrimSpace(u.Dictation.Model)
		if via == "" && cleanURL == "" && model == "" {
			next.Dictation = nil
		} else {
			next.Dictation = &storedDictation{Via: via, URL: cleanURL, Model: model}
		}
	}
	if u.MemorySources != nil {
		next.MemorySources = mergeMemorySources(s.stored.MemorySources, u.MemorySources)
	}
	if u.Voice != nil {
		loc := effectiveLocale(next)
		defs := DefaultVoiceSettings(loc, s.envVoiceID())
		merged := applyVoicePatch(defs, *u.Voice)
		diff := diffVoicePatch(defs, merged)
		next.Voice = diff
	}

	if err := s.persistLocked(next); err != nil {
		return SettingsStatus{}, fmt.Errorf("%w: %v", ErrSettingRefused, err)
	}
	s.stored = next
	return s.statusLocked(), nil
}

// ProviderStatus returns the current provider connections and bindings with all keys masked.
func (s *Service) ProviderStatus() ProviderStatus {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return buildProviderStatus(s.effectiveProvidersLocked())
}

// UpdateProviders validates and atomically persists a ProviderUpdate using optimistic revision CAS.
func (s *Service) UpdateProviders(ctx context.Context, u ProviderUpdate) (ProviderStatus, error) {
	if err := ctx.Err(); err != nil {
		return ProviderStatus{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	cur := s.effectiveProvidersLocked()
	next, err := applyProviderUpdate(cur, u)
	if err != nil {
		return ProviderStatus{}, err
	}
	updated := cloneStoredSettings(s.stored)
	updated.Providers = &next
	if err := s.persistLocked(updated); err != nil {
		return ProviderStatus{}, fmt.Errorf("%w: %v", ErrProviderRefused, err)
	}
	s.stored = updated
	return buildProviderStatus(next), nil
}

// ListProviders returns the static catalog of supported providers.
func (s *Service) ListProviders() []ProviderDescriptor {
	return CatalogProviders()
}

// ListModels returns catalog models when req is nil or connection is empty, or fetches live MOSS models for a bound connection.
func (s *Service) ListModels(ctx context.Context, req *ProviderModelRequest) (ProviderModelListing, error) {
	if req == nil || strings.TrimSpace(req.Connection) == "" {
		return ProviderModelListing{Models: CatalogModels()}, nil
	}
	s.mu.RLock()
	prov := s.effectiveProvidersLocked()
	if req.Revision != prov.Revision {
		s.mu.RUnlock()
		return ProviderModelListing{}, fmt.Errorf("%w: provider settings changed", ErrProviderRefused)
	}
	conn, ok := prov.boundConnection(req.Connection)
	s.mu.RUnlock()
	if !ok {
		return ProviderModelListing{}, fmt.Errorf("%w: provider connection %q has no active key", ErrProviderRefused, req.Connection)
	}

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, s.mossBase+"/models", nil)
	if err != nil {
		return ProviderModelListing{}, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+conn.Key)
	httpReq.Header.Set("Accept", "application/json")

	resp, err := s.httpClient.Do(httpReq)
	if err != nil {
		return ProviderModelListing{}, fmt.Errorf("%w: network error: %v", ErrProviderRefused, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ProviderModelListing{}, fmt.Errorf("%w: upstream HTTP %d", ErrProviderRefused, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBodyLen))
	if err != nil {
		return ProviderModelListing{}, fmt.Errorf("%w: read body: %v", ErrProviderRefused, err)
	}
	var decoded struct {
		Object string `json:"object"`
		Data   []struct {
			ID      string `json:"id"`
			OwnedBy string `json:"owned_by"`
		} `json:"data"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		return ProviderModelListing{}, fmt.Errorf("%w: invalid response: %v", ErrProviderRefused, err)
	}
	models := make([]ProviderModel, 0, len(decoded.Data))
	for _, m := range decoded.Data {
		if m.ID != "" {
			models = append(models, ProviderModel{ID: m.ID, Owner: m.OwnedBy})
		}
	}
	s.mu.RLock()
	currentRev := s.effectiveProvidersLocked().Revision
	s.mu.RUnlock()
	if currentRev != req.Revision {
		return ProviderModelListing{}, fmt.Errorf("%w: provider settings changed", ErrProviderRefused)
	}
	return ProviderModelListing{
		Connection: conn.ID,
		Revision:   currentRev,
		Models:     models,
	}, nil
}

// ListVoiceProviders returns the supported ASR, answer LLM, and TTS voice provider options.
func (s *Service) ListVoiceProviders() []VoiceProviderDescriptor {
	return CatalogVoiceProviders()
}

// ListProviderVoices fetches cloned voices from a bound MOSS connection.
func (s *Service) ListProviderVoices(ctx context.Context, req ProviderVoiceRequest) (ProviderVoiceListing, error) {
	s.mu.RLock()
	prov := s.effectiveProvidersLocked()
	if req.Revision != prov.Revision {
		s.mu.RUnlock()
		return ProviderVoiceListing{}, fmt.Errorf("%w: provider settings changed", ErrProviderRefused)
	}
	conn, ok := prov.boundConnection(req.Connection)
	s.mu.RUnlock()
	if !ok {
		return ProviderVoiceListing{}, fmt.Errorf("%w: provider connection %q has no active key", ErrProviderRefused, req.Connection)
	}

	u, err := url.Parse(s.mossBase + "/voices")
	if err != nil {
		return ProviderVoiceListing{}, err
	}
	q := u.Query()
	if req.Limit != nil {
		q.Set("limit", strconv.Itoa(*req.Limit))
	}
	if req.Offset != nil {
		q.Set("offset", strconv.Itoa(*req.Offset))
	}
	if req.After != "" {
		q.Set("after", req.After)
	}
	if req.Status != "" {
		q.Set("status", req.Status)
	}
	u.RawQuery = q.Encode()

	httpReq, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return ProviderVoiceListing{}, err
	}
	httpReq.Header.Set("Authorization", "Bearer "+conn.Key)
	httpReq.Header.Set("Accept", "application/json")

	resp, err := s.httpClient.Do(httpReq)
	if err != nil {
		return ProviderVoiceListing{}, fmt.Errorf("%w: network error: %v", ErrProviderRefused, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return ProviderVoiceListing{}, fmt.Errorf("%w: upstream HTTP %d", ErrProviderRefused, resp.StatusCode)
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxResponseBodyLen))
	if err != nil {
		return ProviderVoiceListing{}, fmt.Errorf("%w: read body: %v", ErrProviderRefused, err)
	}
	var decoded struct {
		Voices []struct {
			ID        string `json:"id"`
			Name      string `json:"name"`
			CreatedAt int64  `json:"created_at"`
		} `json:"voices"`
		HasMore    bool    `json:"has_more"`
		NextCursor *string `json:"next_cursor"`
	}
	if err := json.Unmarshal(body, &decoded); err != nil {
		return ProviderVoiceListing{}, fmt.Errorf("%w: invalid response: %v", ErrProviderRefused, err)
	}
	voices := make([]ProviderVoice, 0, len(decoded.Voices))
	for _, v := range decoded.Voices {
		voices = append(voices, ProviderVoice{ID: v.ID, Name: v.Name, CreatedAtSeconds: v.CreatedAt})
	}
	return ProviderVoiceListing{
		Connection: conn.ID,
		Revision:   req.Revision,
		Voices:     voices,
		HasMore:    decoded.HasMore,
		NextCursor: decoded.NextCursor,
	}, nil
}

// ResolveAPIKey resolves an API key honoring env > settings.json > config.AppConfig.
// The returned origin is "env", "settings", or "config".
func (s *Service) ResolveAPIKey(provider string) (key, origin string, ok bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	switch strings.ToLower(strings.TrimSpace(provider)) {
	case "deepseek":
		return s.resolveDeepseekKeyLocked()
	case "anthropic":
		return s.resolveAnthropicKeyLocked()
	case "openai":
		return s.resolveOpenAIKeyLocked()
	case "agora_certificate", "agora":
		return s.resolveAgoraCertLocked()
	default:
		return "", "", false
	}
}

// ResolveAgora returns Agora AppID and AppCertificate honoring env > settings.json > config.AppConfig.
func (s *Service) ResolveAgora() (appID, appCertificate string, ok bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	id, _, idOK := s.resolveAgoraAppIDLocked()
	cert, _, certOK := s.resolveAgoraCertLocked()
	if !idOK || !certOK {
		return "", "", false
	}
	return id, cert, true
}

// ResolveWorkRoot returns the active workspace root honoring VIBEVALLEY_WORK_ROOT > settings.json > config.AppConfig > defaults.
func (s *Service) ResolveWorkRoot() string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.resolveWorkRootLocked()
}

// Voice returns the effective VoiceSettings after merging env, settings.json, and defaults.
func (s *Service) Voice() VoiceSettings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.effectiveVoiceLocked(s.stored)
}

// Dictation returns the resolved server-side dictation configuration.
func (s *Service) Dictation() DictationConfig {
	s.mu.RLock()
	defer s.mu.RUnlock()
	d := s.stored.Dictation
	if d == nil || d.Via != "own" {
		return DictationConfig{Via: "moss"}
	}
	return DictationConfig{
		Via:   "own",
		URL:   d.URL,
		Model: d.Model,
		Key:   s.stored.DictationKey,
	}
}

// MaskKey returns a redacted key preview showing at most the trailing 4 characters.
func MaskKey(raw string) string {
	if raw == "" {
		return ""
	}
	if len(raw) <= 4 {
		return "…" + strings.Repeat("*", len(raw))
	}
	return "…" + raw[len(raw)-4:]
}

func makeKeyStatus(raw, wireSource string) KeyStatus {
	if raw == "" {
		return KeyStatus{Source: nil}
	}
	src := wireSource
	return KeyStatus{Source: &src, Hint: MaskKey(raw)}
}

func wireSourceOf(origin string) string {
	if origin == "settings" {
		return "settings"
	}
	return "config"
}

func (s *Service) envVal(names ...string) string {
	for _, n := range names {
		if v := strings.TrimSpace(s.getenv(n)); v != "" {
			return v
		}
	}
	return ""
}

func (s *Service) configSecret(keys ...string) string {
	if s.appCfg == nil || len(s.appCfg.Secrets) == 0 {
		return ""
	}
	for _, k := range keys {
		if v := strings.TrimSpace(s.appCfg.Secrets[k]); v != "" {
			return v
		}
	}
	return ""
}

func resolveChain(envVal, settingsVal, configVal string) (val, origin string, ok bool) {
	if envVal != "" {
		return envVal, "env", true
	}
	if settingsVal != "" {
		return settingsVal, "settings", true
	}
	if configVal != "" {
		return configVal, "config", true
	}
	return "", "", false
}

func (s *Service) resolveDeepseekKeyLocked() (string, string, bool) {
	cfgKey := ""
	if s.appCfg != nil {
		cfgKey = strings.TrimSpace(s.appCfg.DeepSeek.APIKey)
	}
	return resolveChain(
		s.envVal("DEEPSEEK_API_KEY", "VIBEVALLEY_DEEPSEEK_API_KEY"),
		s.stored.DeepseekAPIKey,
		cfgKey,
	)
}

func (s *Service) resolveAnthropicKeyLocked() (string, string, bool) {
	return resolveChain(
		s.envVal("ANTHROPIC_API_KEY", "VIBEVALLEY_ANTHROPIC_API_KEY"),
		s.stored.AnthropicAPIKey,
		s.configSecret("anthropic_api_key", "ANTHROPIC_API_KEY"),
	)
}

func (s *Service) resolveOpenAIKeyLocked() (string, string, bool) {
	return resolveChain(
		s.envVal("OPENAI_API_KEY", "VIBEVALLEY_OPENAI_API_KEY"),
		s.stored.OpenAIAPIKey,
		s.configSecret("openai_api_key", "OPENAI_API_KEY"),
	)
}

func (s *Service) resolveAgoraAppIDLocked() (string, string, bool) {
	return resolveChain(
		s.envVal("AGORA_APP_ID", "VIBEVALLEY_AGORA_APP_ID"),
		s.stored.AgoraAppID,
		s.configSecret("agora_app_id", "AGORA_APP_ID"),
	)
}

func (s *Service) resolveAgoraCertLocked() (string, string, bool) {
	return resolveChain(
		s.envVal("AGORA_APP_CERTIFICATE", "VIBEVALLEY_AGORA_APP_CERTIFICATE"),
		s.stored.AgoraAppCertificate,
		s.configSecret("agora_app_certificate", "AGORA_APP_CERTIFICATE"),
	)
}

func (s *Service) envVoiceID() string {
	if v := s.envVal("VIBEVALLEY_VOICE_ID"); v != "" {
		return v
	}
	return s.configSecret("voice_id", "VIBEVALLEY_VOICE_ID")
}

func (s *Service) resolveWorkRootLocked() string {
	if v := s.envVal("VIBEVALLEY_WORK_ROOT"); v != "" {
		return v
	}
	if s.stored.WorkRoot != "" {
		return s.stored.WorkRoot
	}
	if s.appCfg != nil {
		if wr := strings.TrimSpace(s.appCfg.Server.WorkRoot); wr != "" {
			return wr
		}
		if wr := strings.TrimSpace(s.appCfg.WorkRoot); wr != "" {
			return wr
		}
	}
	if s.homeDir != "" {
		return filepath.Join(s.homeDir, "work")
	}
	return "work"
}

func effectiveLocale(st storedSettings) string {
	if st.Locale != "" {
		return st.Locale
	}
	return "zh"
}

func (s *Service) effectiveVoiceLocked(st storedSettings) VoiceSettings {
	loc := effectiveLocale(st)
	defs := DefaultVoiceSettings(loc, s.envVoiceID())
	v := defs
	if st.Voice != nil {
		v = applyVoicePatch(defs, *st.Voice)
	}
	if envVoice := s.envVal("VIBEVALLEY_VOICE_ID"); envVoice != "" {
		if v.TTS.Vendor != "minimax" {
			v.TTS = VoiceTTS{Vendor: "minimax", Model: "speech_2_6_turbo", VoiceID: envVoice}
		} else {
			v.TTS.VoiceID = envVoice
		}
	}
	return v
}

func (s *Service) effectiveProvidersLocked() storedProviders {
	if s.stored.Providers != nil {
		return *s.stored.Providers
	}
	return storedProviders{Connections: []storedConnection{}}
}

func (s *Service) statusLocked() SettingsStatus {
	loc := effectiveLocale(s.stored)
	workRoot := s.resolveWorkRootLocked()
	defs := DefaultVoiceSettings(loc, s.envVoiceID())
	voice := s.effectiveVoiceLocked(s.stored)

	dsKey, dsOrigin, dsOK := s.resolveDeepseekKeyLocked()
	antKey, antOrigin, antOK := s.resolveAnthropicKeyLocked()
	oaiKey, oaiOrigin, oaiOK := s.resolveOpenAIKeyLocked()
	agID, agIDOrigin, agIDOK := s.resolveAgoraAppIDLocked()
	agCert, agCertOrigin, agCertOK := s.resolveAgoraCertLocked()

	var agoraIDStatus AgoraAppID
	if agIDOK {
		src := wireSourceOf(agIDOrigin)
		agoraIDStatus = AgoraAppID{Source: &src, Value: agID}
	}

	var dsStatus, antStatus, oaiStatus, agCertStatus KeyStatus
	if dsOK {
		dsStatus = makeKeyStatus(dsKey, wireSourceOf(dsOrigin))
	}
	if antOK {
		antStatus = makeKeyStatus(antKey, wireSourceOf(antOrigin))
	}
	if oaiOK {
		oaiStatus = makeKeyStatus(oaiKey, wireSourceOf(oaiOrigin))
	}
	if agCertOK {
		agCertStatus = makeKeyStatus(agCert, wireSourceOf(agCertOrigin))
	}

	dict := Dictation{Via: "moss"}
	if s.stored.Dictation != nil {
		via := s.stored.Dictation.Via
		if via == "" {
			via = "moss"
		}
		dict = Dictation{
			Via:   via,
			URL:   s.stored.Dictation.URL,
			Model: s.stored.Dictation.Model,
		}
	}

	memSources := make([]MemorySource, 0, len(s.stored.MemorySources))
	for _, m := range s.stored.MemorySources {
		memSources = append(memSources, MemorySource{
			Kind:       m.Kind,
			URL:        m.URL,
			Enabled:    m.Enabled,
			Read:       m.Read,
			Write:      m.Write,
			Everything: m.Everything,
			User:       m.User,
			Key:        makeKeyStatus(m.Key, "settings"),
		})
	}

	return SettingsStatus{
		File:     s.filePath,
		Home:     s.homeDir,
		WorkRoot: workRoot,
		Paths: SpacePaths{
			Repos:     filepath.Join(workRoot, "repos"),
			Worktrees: filepath.Join(workRoot, "worktrees"),
			PKM:       filepath.Join(workRoot, "pkm"),
		},
		Version:             s.version,
		Locale:              loc,
		DeepseekAPIKey:      dsStatus,
		AnthropicAPIKey:     antStatus,
		OpenAIAPIKey:        oaiStatus,
		AgoraAppID:          agoraIDStatus,
		AgoraAppCertificate: agCertStatus,
		Voice:               voice,
		VoiceDefaults:       defs,
		ASRKey:              makeKeyStatus(s.stored.ASRKey, "settings"),
		LLMKey:              makeKeyStatus(s.stored.LLMKey, "settings"),
		TTSKey:              makeKeyStatus(s.stored.TTSKey, "settings"),
		Dictation:           dict,
		DictationKey:        makeKeyStatus(s.stored.DictationKey, "settings"),
		Readiness: readinessOf(ReadinessInput{
			Providers:   s.effectiveProvidersLocked(),
			DeepSeekKey: dsOK,
			Agora:       agIDOK && agCertOK,
			Dictation:   dict,
			CallAnswer:  voice.Answer.Vendor,
		}),
		MemorySources: memSources,
	}
}

func buildProviderStatus(p storedProviders) ProviderStatus {
	conns := make([]ProviderConnection, 0, len(p.Connections))
	for _, c := range p.Connections {
		conns = append(conns, ProviderConnection{
			ID:      c.ID,
			Name:    c.Name,
			Adapter: c.Adapter,
			Enabled: c.Enabled,
			Key:     makeKeyStatus(c.Key, "settings"),
		})
	}
	return ProviderStatus{
		Revision:            p.Revision,
		Connections:         conns,
		Dictation:           cloneBinding(p.Dictation),
		Image:               cloneBinding(p.Image),
		Live:                cloneBinding(p.Live),
		LiveModels:          slices.Clone(MOSSLiveModels),
		Speakers:            cloneBinding(p.Speakers),
		SpeakersModels:      slices.Clone(MOSSSpeakersModels),
		VoiceDesign:         cloneBinding(p.VoiceDesign),
		VoiceDesignModels:   slices.Clone(MOSSVoiceDesignModels),
		Transcription:       cloneBinding(p.Transcription),
		TranscriptionModels: slices.Clone(MOSSTranscriptionModels),
		Vision:              cloneBinding(p.Vision),
		VisionModels:        slices.Clone(MOSSVisionModels),
		DictationModels:     slices.Clone(MOSSDictationModels),
		ImageModels:         slices.Clone(MOSSImageModels),
		Understanding:       cloneBinding(p.Understanding),
		UnderstandingModels: slices.Clone(MOSSUnderstandingModels),
		Speech:              cloneBinding(p.Speech),
		SpeechModels:        slices.Clone(MOSSSpeechModels),
	}
}

func applyProviderUpdate(current storedProviders, u ProviderUpdate) (storedProviders, error) {
	if u.Revision != current.Revision {
		return storedProviders{}, fmt.Errorf("%w: revision mismatch (got %d, want %d)", ErrProviderRefused, u.Revision, current.Revision)
	}
	if len(u.Connections) > maxConnections {
		return storedProviders{}, fmt.Errorf("%w: too many connections (max %d)", ErrProviderRefused, maxConnections)
	}
	seen := make(map[string]struct{}, len(u.Connections))
	conns := make([]storedConnection, 0, len(u.Connections))
	for _, input := range u.Connections {
		if !connIDRe.MatchString(input.ID) {
			return storedProviders{}, fmt.Errorf("%w: invalid connection id %q", ErrProviderRefused, input.ID)
		}
		if _, dup := seen[input.ID]; dup {
			return storedProviders{}, fmt.Errorf("%w: duplicate connection id %q", ErrProviderRefused, input.ID)
		}
		seen[input.ID] = struct{}{}
		name := strings.TrimSpace(input.Name)
		if name == "" || len([]rune(name)) > 80 {
			return storedProviders{}, fmt.Errorf("%w: invalid connection name", ErrProviderRefused)
		}
		adapter := input.Adapter
		if adapter == "" {
			adapter = "moss"
		}
		if adapter != "moss" {
			return storedProviders{}, fmt.Errorf("%w: unsupported adapter %q", ErrProviderRefused, adapter)
		}
		existingKey := ""
		if prev, ok := current.findConnection(input.ID); ok {
			existingKey = prev.Key
		}
		var key string
		switch {
		case input.ClearKey:
			key = ""
		case input.Key == nil:
			key = existingKey
		default:
			trimmed := strings.TrimSpace(*input.Key)
			if trimmed == "" || whitespaceRe.MatchString(trimmed) || len(trimmed) > maxProviderKeyLen {
				return storedProviders{}, fmt.Errorf("%w: invalid connection key", ErrProviderRefused)
			}
			key = trimmed
		}
		conns = append(conns, storedConnection{
			ID:      input.ID,
			Name:    name,
			Adapter: adapter,
			Enabled: input.Enabled,
			Key:     key,
		})
	}

	next := storedProviders{
		Revision:      current.Revision + 1,
		Connections:   conns,
		Dictation:     cloneBinding(u.Dictation),
		Image:         cloneBinding(u.Image),
		Speech:        cloneBinding(u.Speech),
		Understanding: cloneBinding(u.Understanding),
		Live:          cloneBinding(u.Live),
		Speakers:      cloneBinding(u.Speakers),
		VoiceDesign:   cloneBinding(u.VoiceDesign),
		Transcription: cloneBinding(u.Transcription),
		Vision:        cloneBinding(u.Vision),
	}
	checks := []struct {
		use     string
		binding *ProviderBinding
		models  []string
	}{
		{"dictation", next.Dictation, MOSSDictationModels},
		{"image", next.Image, MOSSImageModels},
		{"understanding", next.Understanding, MOSSUnderstandingModels},
		{"speech", next.Speech, MOSSSpeechModels},
		{"live", next.Live, MOSSLiveModels},
		{"speakers", next.Speakers, MOSSSpeakersModels},
		{"voiceDesign", next.VoiceDesign, MOSSVoiceDesignModels},
		{"transcription", next.Transcription, MOSSTranscriptionModels},
		{"vision", next.Vision, MOSSVisionModels},
	}
	for _, c := range checks {
		if c.binding == nil {
			continue
		}
		if _, ok := next.boundConnection(c.binding.Connection); !ok {
			return storedProviders{}, fmt.Errorf("%w: %s bound to unavailable connection %q", ErrProviderRefused, c.use, c.binding.Connection)
		}
		if !slices.Contains(c.models, c.binding.Model) {
			return storedProviders{}, fmt.Errorf("%w: unsupported model %q for %s", ErrProviderRefused, c.binding.Model, c.use)
		}
	}
	return next, nil
}

func settingsProblem(u SettingsUpdate) string {
	if u.Locale != nil {
		loc := strings.TrimSpace(*u.Locale)
		if loc != "" && loc != "zh" && loc != "en" {
			return fmt.Sprintf("unsupported locale %q", loc)
		}
	}
	if u.DeepseekAPIKey != nil {
		k := strings.TrimSpace(*u.DeepseekAPIKey)
		if k != "" && (whitespaceRe.MatchString(k) || len(k) < 8) {
			return "DeepSeek API key must be at least 8 characters with no whitespace"
		}
	}
	if u.AnthropicAPIKey != nil {
		k := strings.TrimSpace(*u.AnthropicAPIKey)
		if k != "" && (whitespaceRe.MatchString(k) || len(k) < 8) {
			return "Anthropic API key must be at least 8 characters with no whitespace"
		}
	}
	if u.OpenAIAPIKey != nil {
		k := strings.TrimSpace(*u.OpenAIAPIKey)
		if k != "" && (whitespaceRe.MatchString(k) || len(k) < 8) {
			return "OpenAI API key must be at least 8 characters with no whitespace"
		}
	}
	if u.AgoraAppID != nil {
		id := strings.TrimSpace(*u.AgoraAppID)
		if id != "" && !agoraHexRe.MatchString(id) {
			return "Agora App ID must be 32 hexadecimal characters"
		}
	}
	if u.AgoraAppCertificate != nil {
		cert := strings.TrimSpace(*u.AgoraAppCertificate)
		if cert != "" && !agoraHexRe.MatchString(cert) {
			return "Agora App Certificate must be 32 hexadecimal characters"
		}
	}
	for _, kp := range []*string{u.ASRKey, u.LLMKey, u.TTSKey, u.DictationKey} {
		if kp != nil && whitespaceRe.MatchString(strings.TrimSpace(*kp)) {
			return "voice key must not contain whitespace"
		}
	}
	if u.Dictation != nil && u.Dictation.Via == "own" {
		rawURL := strings.TrimSpace(u.Dictation.URL)
		if rawURL != "" {
			if !httpURLRe.MatchString(rawURL) {
				return "dictation URL must start with http:// or https://"
			}
			if strings.TrimSpace(u.Dictation.Model) == "" {
				return "dictation model is required when custom URL is set"
			}
		}
	}
	if u.MemorySources != nil {
		seen := make(map[string]struct{}, len(u.MemorySources))
		for _, m := range u.MemorySources {
			if m.Kind != "nowledge" && m.Kind != "everos" {
				return fmt.Sprintf("unknown memory source kind %q", m.Kind)
			}
			if _, dup := seen[m.Kind]; dup {
				return fmt.Sprintf("duplicate memory source kind %q", m.Kind)
			}
			seen[m.Kind] = struct{}{}
			rawURL := strings.TrimSpace(m.URL)
			if m.Enabled && rawURL == "" {
				return "enabled memory source requires a URL"
			}
			if rawURL != "" && !httpURLRe.MatchString(rawURL) {
				return "memory source URL must start with http:// or https://"
			}
			if m.Key != nil && whitespaceRe.MatchString(strings.TrimSpace(*m.Key)) {
				return "memory source key must not contain whitespace"
			}
		}
	}
	if u.Voice != nil {
		if p := voiceProblem(*u.Voice); p != "" {
			return p
		}
	}
	return ""
}

func voiceProblem(v VoicePatch) string {
	if v.Area != nil && !slices.Contains(VoiceAreas, *v.Area) {
		return fmt.Sprintf("unsupported voice area %q", *v.Area)
	}
	if v.Language != nil && !slices.Contains(VoiceLanguages, *v.Language) {
		return fmt.Sprintf("unsupported voice language %q", *v.Language)
	}
	if v.ASR != nil {
		switch v.ASR.Vendor {
		case "ares":
		case "deepgram":
			if !slices.Contains(DeepgramModels, v.ASR.Model) {
				return fmt.Sprintf("unsupported deepgram model %q", v.ASR.Model)
			}
		case "microsoft":
			if strings.TrimSpace(v.ASR.Region) == "" {
				return "Microsoft ASR region is required"
			}
		default:
			return fmt.Sprintf("unsupported ASR vendor %q", v.ASR.Vendor)
		}
	}
	if v.Answer != nil {
		switch v.Answer.Vendor {
		case "orchestrator", "moss":
		case "agora":
			if !slices.Contains(VoiceAnswerAgoraModels, v.Answer.Model) {
				return fmt.Sprintf("unsupported Agora LLM model %q", v.Answer.Model)
			}
		case "deepseek":
			if strings.TrimSpace(v.Answer.Model) == "" {
				return "DeepSeek answer model is required"
			}
		case "openai":
			if strings.TrimSpace(v.Answer.Model) == "" {
				return "OpenAI answer model is required"
			}
			if !httpURLRe.MatchString(strings.TrimSpace(v.Answer.URL)) {
				return "OpenAI answer URL must start with http:// or https://"
			}
		default:
			return fmt.Sprintf("unsupported answer vendor %q", v.Answer.Vendor)
		}
	}
	if v.TTS != nil {
		switch v.TTS.Vendor {
		case "minimax":
			if !slices.Contains(VoiceTTSMinimaxModels, v.TTS.Model) {
				return fmt.Sprintf("unsupported MiniMax TTS model %q", v.TTS.Model)
			}
			if strings.TrimSpace(v.TTS.VoiceID) == "" {
				return "MiniMax voiceId is required"
			}
		case "openai":
			if !slices.Contains(VoiceTTSOpenAIVoices, v.TTS.Voice) {
				return fmt.Sprintf("unsupported OpenAI TTS voice %q", v.TTS.Voice)
			}
		case "microsoft":
			if strings.TrimSpace(v.TTS.Region) == "" || strings.TrimSpace(v.TTS.VoiceName) == "" {
				return "Microsoft TTS requires both region and voiceName"
			}
		default:
			return fmt.Sprintf("unsupported TTS vendor %q", v.TTS.Vendor)
		}
	}
	if v.Persona != nil && strings.TrimSpace(*v.Persona) == "" {
		return "voice persona cannot be blank"
	}
	if v.SilenceMs != nil && (*v.SilenceMs < voiceSilenceMin || *v.SilenceMs > voiceSilenceMax) {
		return fmt.Sprintf("silenceMs must be between %d and %d", voiceSilenceMin, voiceSilenceMax)
	}
	if v.InterruptMs != nil && (*v.InterruptMs < voiceInterruptMin || *v.InterruptMs > voiceInterruptMax) {
		return fmt.Sprintf("interruptMs must be between %d and %d", voiceInterruptMin, voiceInterruptMax)
	}
	if v.IdleSeconds != nil && (*v.IdleSeconds < voiceIdleMin || *v.IdleSeconds > voiceIdleMax) {
		return fmt.Sprintf("idleSeconds must be between %d and %d", voiceIdleMin, voiceIdleMax)
	}
	return ""
}

func applyVoicePatch(base VoiceSettings, p VoicePatch) VoiceSettings {
	out := base
	if p.Area != nil {
		out.Area = *p.Area
	}
	if p.Language != nil {
		out.Language = *p.Language
	}
	if p.ASR != nil {
		out.ASR = *p.ASR
	}
	if p.Answer != nil {
		out.Answer = *p.Answer
	}
	if p.TTS != nil {
		out.TTS = *p.TTS
	}
	if p.Persona != nil {
		out.Persona = *p.Persona
	}
	if p.Greeting != nil {
		out.Greeting = *p.Greeting
	}
	if p.FailureMessage != nil {
		out.FailureMessage = *p.FailureMessage
	}
	if p.SilenceMs != nil {
		out.SilenceMs = *p.SilenceMs
	}
	if p.InterruptMs != nil {
		out.InterruptMs = *p.InterruptMs
	}
	if p.IdleSeconds != nil {
		out.IdleSeconds = *p.IdleSeconds
	}
	return out
}

func diffVoicePatch(defs, cur VoiceSettings) *VoicePatch {
	var diff VoicePatch
	changed := false
	if cur.Area != defs.Area {
		v := cur.Area
		diff.Area = &v
		changed = true
	}
	if cur.Language != defs.Language {
		v := cur.Language
		diff.Language = &v
		changed = true
	}
	if cur.ASR != defs.ASR {
		v := cur.ASR
		diff.ASR = &v
		changed = true
	}
	if cur.Answer != defs.Answer {
		v := cur.Answer
		diff.Answer = &v
		changed = true
	}
	if cur.TTS != defs.TTS {
		v := cur.TTS
		diff.TTS = &v
		changed = true
	}
	if cur.Persona != defs.Persona {
		v := cur.Persona
		diff.Persona = &v
		changed = true
	}
	if cur.Greeting != defs.Greeting {
		v := cur.Greeting
		diff.Greeting = &v
		changed = true
	}
	if cur.FailureMessage != defs.FailureMessage {
		v := cur.FailureMessage
		diff.FailureMessage = &v
		changed = true
	}
	if cur.SilenceMs != defs.SilenceMs {
		v := cur.SilenceMs
		diff.SilenceMs = &v
		changed = true
	}
	if cur.InterruptMs != defs.InterruptMs {
		v := cur.InterruptMs
		diff.InterruptMs = &v
		changed = true
	}
	if cur.IdleSeconds != defs.IdleSeconds {
		v := cur.IdleSeconds
		diff.IdleSeconds = &v
		changed = true
	}
	if !changed {
		return nil
	}
	return &diff
}

func mergeMemorySources(saved []storedMemorySource, given []MemorySourceUpdate) []storedMemorySource {
	if len(given) == 0 {
		return nil
	}
	prevByKind := make(map[string]string, len(saved))
	for _, s := range saved {
		prevByKind[s.Kind] = s.Key
	}
	out := make([]storedMemorySource, 0, len(given))
	for _, m := range given {
		key := prevByKind[m.Kind]
		if m.Key != nil {
			key = strings.TrimSpace(*m.Key)
		}
		user := ""
		if m.User != nil {
			user = strings.TrimSpace(*m.User)
		}
		everything := m.Everything != nil && *m.Everything
		out = append(out, storedMemorySource{
			Kind:       m.Kind,
			URL:        strings.TrimSpace(m.URL),
			Enabled:    m.Enabled,
			Read:       m.Read,
			Write:      m.Write,
			Everything: everything,
			User:       user,
			Key:        key,
		})
	}
	return out
}

func cloneBinding(b *ProviderBinding) *ProviderBinding {
	if b == nil {
		return nil
	}
	cp := *b
	return &cp
}

func cloneStoredSettings(in storedSettings) storedSettings {
	out := in
	if in.Voice != nil {
		vp := *in.Voice
		out.Voice = &vp
	}
	if in.Dictation != nil {
		dp := *in.Dictation
		out.Dictation = &dp
	}
	if in.Providers != nil {
		pp := *in.Providers
		pp.Connections = slices.Clone(in.Providers.Connections)
		pp.Dictation = cloneBinding(in.Providers.Dictation)
		pp.Image = cloneBinding(in.Providers.Image)
		pp.Speech = cloneBinding(in.Providers.Speech)
		pp.Understanding = cloneBinding(in.Providers.Understanding)
		pp.Live = cloneBinding(in.Providers.Live)
		pp.Speakers = cloneBinding(in.Providers.Speakers)
		pp.VoiceDesign = cloneBinding(in.Providers.VoiceDesign)
		pp.Transcription = cloneBinding(in.Providers.Transcription)
		pp.Vision = cloneBinding(in.Providers.Vision)
		out.Providers = &pp
	}
	if in.MemorySources != nil {
		out.MemorySources = slices.Clone(in.MemorySources)
	}
	return out
}

func (s *Service) loadFromDisk() error {
	raw, err := os.ReadFile(s.filePath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return fmt.Errorf("read %s: %w", s.filePath, err)
	}
	var st storedSettings
	if err := json.Unmarshal(raw, &st); err != nil {
		aside := fmt.Sprintf("%s.unreadable-%d", s.filePath, s.clock.NowMs())
		if renameErr := os.Rename(s.filePath, aside); renameErr != nil {
			return fmt.Errorf("%s cannot be parsed and could not be set aside: %w", s.filePath, renameErr)
		}
		s.stored = storedSettings{}
		return nil
	}
	s.stored = st
	return nil
}

func (s *Service) persistLocked(next storedSettings) error {
	if s.filePath == "" {
		return nil
	}
	data, err := json.MarshalIndent(next, "", "  ")
	if err != nil {
		return err
	}
	data = append(data, '\n')
	return writeAtomic0600(s.filePath, data)
}

func writeAtomic0600(path string, data []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "."+filepath.Base(path)+".*.tmp")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	cleanup := true
	defer func() {
		if cleanup {
			_ = tmp.Close()
			_ = os.Remove(tmpName)
		}
	}()
	if err := tmp.Chmod(0o600); err != nil {
		return err
	}
	if _, err := tmp.Write(data); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, path); err != nil {
		return err
	}
	cleanup = false
	return nil
}
