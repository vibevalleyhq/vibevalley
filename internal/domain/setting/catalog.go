package setting

import "slices"

// Static model catalogs matching packages/provider/src/moss/*-models.ts and vendors.ts.
var (
	MOSSImageModels = []string{
		"moss-image-base-1.0",
		"moss-image-sft-1.0",
		"moss-image-base-1.0-2026-10-09",
		"moss-image-sft-1.0-2026-10-09",
	}
	MOSSLiveModels = []string{
		"moss-live-1.0",
		"moss-live-1.0-2026-11-02",
	}
	MOSSSpeakersModels = []string{
		"moss-ttsd-1.0",
		"moss-ttsd-1.0-2026-03-20",
	}
	MOSSSpeechModels = []string{
		"moss-tts-1.5-flash",
		"moss-tts-1.5-flash-2026-06-26",
		"moss-tts-1.0-pro",
		"moss-tts-1.0-pro-2026-02-07",
	}
	MOSSTranscriptionModels = []string{
		"moss-transcribe-1.0",
		"moss-transcribe-1.0-2026-07-22",
		"moss-transcribe-diarize-pro",
		"moss-transcribe-diarize-pro-2026-07-03",
	}
	MOSSUnderstandingModels = []string{
		"moss-vl-1.0",
		"moss-vl-1.0-2026-07-08",
	}
	MOSSVisionModels = []string{
		"moss-vl-realtime-1.0",
		"moss-vl-realtime-1.0-2026-09-09",
	}
	MOSSVoiceDesignModels = []string{
		"moss-voice-generator-1.0",
		"moss-voice-generator-1.0-2026-07-22",
	}
	MOSSDictationModels = slices.Clone(MOSSTranscriptionModels)

	DeepSeekModels = []string{
		"deepseek-chat",
		"deepseek-reasoner",
	}
	AnthropicModels = []string{
		"claude-sonnet-4-5",
		"claude-opus-4-5",
		"claude-haiku-4-5",
	}
	OpenAIModels = []string{
		"gpt-4.1",
		"gpt-4.1-mini",
		"gpt-4o",
		"gpt-4o-mini",
		"o3",
		"o4-mini",
	}

	VoiceAreas             = []string{"US", "EU", "AP", "CN"}
	VoiceLanguages         = []string{"zh-CN", "zh-HK", "zh-TW", "en-US", "ja-JP", "ko-KR"}
	DeepgramModels         = []string{"nova-2", "nova-3"}
	VoiceAnswerAgoraModels = []string{"gpt-4o-mini", "gpt-4.1-mini", "gpt-5-nano", "gpt-5-mini"}
	VoiceTTSMinimaxModels  = []string{"speech_2_6_turbo", "speech_2_8_turbo"}
	VoiceTTSOpenAIVoices   = []string{"alloy", "echo", "fable", "onyx", "nova", "shimmer"}
)

const (
	defaultVoicePersonaZH  = "你是码农场物语的助手，一个和气、利落的年轻农夫。农场里的帮工是一群小动物，它们其实是写代码的 AI：后端老周（熊）、测试小吴（兔子）、前端阿郑（小狐狸）、文档员 Kimi（猫）、情报 Grok（猫头鹰）、Pi 实验员（刺猬）、夜班反重力（浣熊）。\n\n用户跟你说要做什么活，你就简短确认会派给谁去做，比如「好，让测试小吴去跑一遍测试」。派活和进度由农场自己处理，你看不到地里的实时情况，不要编造进度、结果或文件名；被问到进度时，就说可以看地里的牌子或者日志。\n\n这是语音对话：每次只说一两句，口语化，不列清单，不用 markdown。一次最多问一个问题。用中文回答。"
	defaultVoicePersonaEN  = "You are the VibeValley orchestrator, a friendly and concise farmer coordinating coding agents. Reply in 1-2 conversational sentences without markdown or lists."
	defaultVoiceGreetingZH = "来啦！今天想种点什么？"
	defaultVoiceGreetingEN = "Hi there! What are we working on today?"
	defaultVoiceFailureZH  = "我这边卡了一下，你再说一遍？"
	defaultVoiceFailureEN  = "I missed that—could you say it again?"
	defaultMinimaxVoiceID  = "Chinese (Mandarin)_Gentle_Youth"
	defaultSilenceMs       = 480
	defaultInterruptMs     = 160
	defaultIdleSeconds     = 30
)

// ProviderDescriptor describes a supported AI or media vendor and its capabilities.
type ProviderDescriptor struct {
	ID           string              `json:"id"`
	Name         string              `json:"name"`
	Console      string              `json:"console"`
	Keys         string              `json:"keys"` // "account" or "setting"
	Capabilities map[string][]string `json:"capabilities,omitempty"`
	VoiceLine    string              `json:"voiceLine,omitempty"`
}

// VoiceProviderDescriptor describes a voice ASR, answer LLM, or TTS vendor option.
type VoiceProviderDescriptor struct {
	Kind           string   `json:"kind"` // "asr", "answer", "tts"
	Vendor         string   `json:"vendor"`
	Label          string   `json:"label"`
	Models         []string `json:"models,omitempty"`
	Voices         []string `json:"voices,omitempty"`
	RequiresKey    bool     `json:"requiresKey"`
	RequiresRegion bool     `json:"requiresRegion,omitempty"`
	RequiresURL    bool     `json:"requiresUrl,omitempty"`
}

// CatalogProviders returns the static list of supported VibeValley model & media providers.
func CatalogProviders() []ProviderDescriptor {
	return []ProviderDescriptor{
		{
			ID:      "moss",
			Name:    "MOSS",
			Console: "https://platform.moss.cn/",
			Keys:    "account",
			Capabilities: map[string][]string{
				"image":         slices.Clone(MOSSImageModels),
				"speech":        slices.Clone(MOSSSpeechModels),
				"speakers":      slices.Clone(MOSSSpeakersModels),
				"voiceDesign":   slices.Clone(MOSSVoiceDesignModels),
				"transcription": slices.Clone(MOSSTranscriptionModels),
				"understanding": slices.Clone(MOSSUnderstandingModels),
				"live":          slices.Clone(MOSSLiveModels),
				"vision":        slices.Clone(MOSSVisionModels),
				"dictation":     slices.Clone(MOSSDictationModels),
			},
		},
		{
			ID:      "deepseek",
			Name:    "DeepSeek",
			Console: "https://platform.deepseek.com/api_keys",
			Keys:    "setting",
			Capabilities: map[string][]string{
				"chat": slices.Clone(DeepSeekModels),
			},
		},
		{
			ID:      "anthropic",
			Name:    "Anthropic",
			Console: "https://console.anthropic.com/settings/keys",
			Keys:    "setting",
			Capabilities: map[string][]string{
				"chat": slices.Clone(AnthropicModels),
			},
		},
		{
			ID:      "openai",
			Name:    "OpenAI",
			Console: "https://platform.openai.com/api-keys",
			Keys:    "setting",
			Capabilities: map[string][]string{
				"chat": slices.Clone(OpenAIModels),
			},
		},
		{
			ID:        "agora",
			Name:      "Agora",
			Console:   "https://console.agora.io/",
			Keys:      "setting",
			VoiceLine: "rtc",
		},
	}
}

// CatalogModels returns all known chat and media models annotated by owner.
func CatalogModels() []ProviderModel {
	var out []ProviderModel
	appendOwned := func(owner string, ids []string) {
		for _, id := range ids {
			out = append(out, ProviderModel{ID: id, Owner: owner})
		}
	}
	appendOwned("deepseek", DeepSeekModels)
	appendOwned("anthropic", AnthropicModels)
	appendOwned("openai", OpenAIModels)
	appendOwned("moss", MOSSImageModels)
	appendOwned("moss", MOSSSpeechModels)
	appendOwned("moss", MOSSSpeakersModels)
	appendOwned("moss", MOSSVoiceDesignModels)
	appendOwned("moss", MOSSTranscriptionModels)
	appendOwned("moss", MOSSUnderstandingModels)
	appendOwned("moss", MOSSLiveModels)
	appendOwned("moss", MOSSVisionModels)
	return out
}

// CatalogVoiceProviders returns the supported ASR, answer LLM, and TTS vendors for voice calls.
func CatalogVoiceProviders() []VoiceProviderDescriptor {
	return []VoiceProviderDescriptor{
		{Kind: "asr", Vendor: "ares", Label: "Agora Ares"},
		{Kind: "asr", Vendor: "deepgram", Label: "Deepgram", Models: slices.Clone(DeepgramModels)},
		{Kind: "asr", Vendor: "microsoft", Label: "Microsoft Azure STT", RequiresKey: true, RequiresRegion: true},
		{Kind: "answer", Vendor: "orchestrator", Label: "VibeValley Orchestrator"},
		{Kind: "answer", Vendor: "moss", Label: "MOSS Live", Models: slices.Clone(MOSSLiveModels)},
		{Kind: "answer", Vendor: "agora", Label: "Agora Hosted LLM", Models: slices.Clone(VoiceAnswerAgoraModels)},
		{Kind: "answer", Vendor: "deepseek", Label: "DeepSeek", Models: slices.Clone(DeepSeekModels), RequiresKey: true},
		{Kind: "answer", Vendor: "openai", Label: "OpenAI Compatible", RequiresKey: true, RequiresURL: true},
		{Kind: "tts", Vendor: "minimax", Label: "MiniMax", Models: slices.Clone(VoiceTTSMinimaxModels)},
		{Kind: "tts", Vendor: "openai", Label: "OpenAI TTS", Voices: slices.Clone(VoiceTTSOpenAIVoices)},
		{Kind: "tts", Vendor: "microsoft", Label: "Microsoft Azure TTS", RequiresKey: true, RequiresRegion: true},
	}
}

// DefaultVoiceSettings returns default VoiceSettings localized for locale and optionally overridden by envVoiceID.
func DefaultVoiceSettings(locale, envVoiceID string) VoiceSettings {
	isEN := locale == "en"
	lang := "zh-CN"
	persona := defaultVoicePersonaZH
	greeting := defaultVoiceGreetingZH
	failureMsg := defaultVoiceFailureZH
	if isEN {
		lang = "en-US"
		persona = defaultVoicePersonaEN
		greeting = defaultVoiceGreetingEN
		failureMsg = defaultVoiceFailureEN
	}
	voiceID := defaultMinimaxVoiceID
	if envVoiceID != "" {
		voiceID = envVoiceID
	}
	return VoiceSettings{
		Area:           "US",
		Language:       lang,
		ASR:            VoiceASR{Vendor: "ares"},
		Answer:         VoiceAnswer{Vendor: "orchestrator"},
		TTS:            VoiceTTS{Vendor: "minimax", Model: "speech_2_6_turbo", VoiceID: voiceID},
		Persona:        persona,
		Greeting:       greeting,
		FailureMessage: failureMsg,
		SilenceMs:      defaultSilenceMs,
		InterruptMs:    defaultInterruptMs,
		IdleSeconds:    defaultIdleSeconds,
	}
}

// FeatureList enumerates all protocol feature readiness keys.
var FeatureList = []string{
	"orchestrator",
	"image",
	"understanding",
	"speech",
	"speakers",
	"voiceDesign",
	"transcription",
	"dictation",
	"live",
	"vision",
	"call",
}

// ReadinessInput feeds readinessOf matching apps/server/src/platform/setting/readiness.ts.
type ReadinessInput struct {
	Providers   storedProviders
	DeepSeekKey bool
	Agora       bool
	Dictation   Dictation
	CallAnswer  string
}

func readinessOf(in ReadinessInput) map[string]Readiness {
	ready := Readiness{Ready: true}
	lacks := func(missing string) Readiness {
		return Readiness{Ready: false, Missing: missing}
	}
	moss := func(use string) Readiness {
		b := in.Providers.bindingFor(use)
		if len(in.Providers.Connections) == 0 {
			return lacks("mossAccount")
		}
		if b == nil {
			return lacks("binding")
		}
		conn, ok := in.Providers.findConnection(b.Connection)
		if !ok {
			return lacks("binding")
		}
		if !conn.Enabled {
			return lacks("mossOff")
		}
		if conn.Key == "" {
			return lacks("mossKey")
		}
		return ready
	}
	live := moss("live")
	orch := lacks("deepseekKey")
	if in.DeepSeekKey {
		orch = ready
	}
	dict := moss("dictation")
	if in.Dictation.Via == "own" {
		if in.Dictation.URL == "" {
			dict = lacks("dictationUrl")
		} else {
			dict = ready
		}
	}
	call := lacks("agora")
	if in.CallAnswer == "moss" {
		call = live
	} else if in.Agora {
		call = ready
	}
	return map[string]Readiness{
		"orchestrator":  orch,
		"image":         moss("image"),
		"understanding": moss("understanding"),
		"speech":        moss("speech"),
		"speakers":      moss("speakers"),
		"voiceDesign":   moss("voiceDesign"),
		"transcription": moss("transcription"),
		"dictation":     dict,
		"live":          live,
		"vision":        moss("vision"),
		"call":          call,
	}
}
