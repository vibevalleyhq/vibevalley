package protocol

import (
	"encoding/json"
	"fmt"
	"regexp"
)

// The page tells the agent's audio and transcripts apart by it.
const VoiceAgentUID = "123456"

var (
	VoiceAreas     = AreaValues
	VoiceLanguages = LanguageValues
	VoiceModels    = VoiceLLMAgoraModelValues
	VoiceTTSModels = VoiceTTSMinimaxModelValues
	DeepgramModels = ModelValues
	OpenAIVoices   = VoiceValues
)

type VoiceChoice struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

// Any other id can be typed.
var MinimaxVoices = []VoiceChoice{
	{ID: "Chinese (Mandarin)_Gentle_Youth", Label: "温润青年"},
	{ID: "male-qn-qingse", Label: "青涩青年"},
	{ID: "male-qn-jingying", Label: "精英青年"},
	{ID: "male-qn-badao", Label: "霸道青年"},
	{ID: "male-qn-daxuesheng", Label: "青年大学生"},
	{ID: "female-shaonv", Label: "少女"},
	{ID: "female-yujie", Label: "御姐"},
	{ID: "female-chengshu", Label: "成熟女性"},
	{ID: "female-tianmei", Label: "甜美女性"},
	{ID: "presenter_male", Label: "男性主持人"},
	{ID: "presenter_female", Label: "女性主持人"},
	{ID: "audiobook_male_1", Label: "男性有声书"},
	{ID: "audiobook_female_1", Label: "女性有声书"},
}

// Any other name can be typed.
var MicrosoftVoices = []string{
	"zh-CN-XiaoxiaoNeural",
	"zh-CN-YunxiNeural",
	"zh-CN-XiaoyiNeural",
	"zh-CN-YunjianNeural",
	"en-US-JennyNeural",
	"en-US-GuyNeural",
}

func NeedsASRKey(asr VoiceASR) bool { _, ok := asr.Value.(VoiceASRMicrosoft); return ok }
func NeedsLLMKey(llm VoiceLLM) bool { _, ok := llm.Value.(VoiceLLMOpenai); return ok }
func NeedsTTSKey(tts VoiceTTS) bool { _, ok := tts.Value.(VoiceTTSMicrosoft); return ok }

const voiceManagerPersona = `你是码农场物语的管家，一个和气、利落的年轻农夫。农场里的帮工是一群小动物，它们其实是写代码的 AI：后端老周（熊）、测试小吴（兔子）、前端阿郑（小狐狸）、文档员 Kimi（猫）、情报 Grok（猫头鹰）、Pi 实验员（刺猬）、夜班反重力（浣熊）。

主人跟你说要做什么活，你就简短确认会派给谁去做，比如「好，让测试小吴去跑一遍测试」。派活和进度由农场自己处理，你看不到地里的实时情况，不要编造进度、结果或文件名；被问到进度时，就说可以看地里的牌子或者日志。

这是语音对话：每次只说一两句，口语化，不列清单，不用 markdown。一次最多问一个问题。用中文回答。`

func DefaultVoice() VoiceSettings {
	return VoiceSettings{
		Area:           AreaUS,
		Language:       LanguageZhCN,
		ASR:            VoiceASR{VoiceASRAres{}},
		LLM:            VoiceLLM{VoiceLLMAgora{Model: VoiceLLMAgoraModelGpt41Mini}},
		TTS:            VoiceTTS{VoiceTTSMinimax{Model: VoiceTTSMinimaxModelSpeech26Turbo, VoiceID: "Chinese (Mandarin)_Gentle_Youth"}},
		Persona:        voiceManagerPersona,
		Greeting:       "来啦！今天想种点什么？",
		FailureMessage: "我这边卡了一下，你再说一遍？",
		SilenceMs:      480,
		InterruptMs:    160,
		IdleSeconds:    30,
	}
}

type VoiceLimit struct{ Min, Max int64 }

var VoiceLimits = map[string]VoiceLimit{
	"silenceMs":   {Min: 200, Max: 2000},
	"interruptMs": {Min: 80, Max: 1000},
	"idleSeconds": {Min: 10, Max: 600},
}

var VoiceFieldLabel = map[string]string{
	"area":           "区域",
	"language":       "语言",
	"asr":            "识别",
	"llm":            "大模型",
	"tts":            "合成",
	"persona":        "人设",
	"greeting":       "开场白",
	"failureMessage": "出错时说",
	"silenceMs":      "停顿多久算说完（毫秒）",
	"interruptMs":    "说多久能打断他（毫秒）",
	"idleSeconds":    "没人时多久离开（秒）",
}

var voiceURL = regexp.MustCompile(`^https?://[^` + coreSpaceClass + `]+$`)

func VoiceProblem(v SettingsUpdateVoice) string {
	if asr, ok := v.ASR.Value.(VoiceASRMicrosoft); ok && coreTrim(asr.Region) == "" {
		return "微软识别要填区域，比如 eastasia"
	}
	switch llm := v.LLM.Value.(type) {
	case VoiceLLMDeepseek:
		if coreTrim(llm.Model) == "" {
			return "大模型要填模型名"
		}
	case VoiceLLMOpenai:
		if coreTrim(llm.Model) == "" {
			return "大模型要填模型名"
		}
		if !voiceURL.MatchString(coreTrim(llm.URL)) {
			return "大模型的地址要是 http(s) 开头的完整地址，比如 https://api.openai.com/v1/chat/completions"
		}
	}
	switch tts := v.TTS.Value.(type) {
	case VoiceTTSMinimax:
		if coreTrim(tts.VoiceID) == "" {
			return "音色不能空着：选一个或填 MiniMax 的音色 id"
		}
	case VoiceTTSMicrosoft:
		if coreTrim(tts.Region) == "" || coreTrim(tts.VoiceName) == "" {
			return "微软合成要填区域和音色名"
		}
	}
	if v.Persona != nil && coreTrim(*v.Persona) == "" {
		return "管家的人设不能空着"
	}
	for _, f := range []struct {
		key string
		n   *int64
	}{{"silenceMs", v.SilenceMs}, {"interruptMs", v.InterruptMs}, {"idleSeconds", v.IdleSeconds}} {
		limit := VoiceLimits[f.key]
		if f.n != nil && (*f.n < limit.Min || *f.n > limit.Max) {
			return fmt.Sprintf("%s要在 %d 到 %d 之间", VoiceFieldLabel[f.key], limit.Min, limit.Max)
		}
	}
	return ""
}

func VoiceSettingsOver(defaults VoiceSettings, overrides SettingsUpdateVoice) VoiceSettings {
	s := defaults
	if overrides.Area != nil {
		s.Area = *overrides.Area
	}
	if overrides.Language != nil {
		s.Language = *overrides.Language
	}
	if overrides.ASR.Value != nil {
		s.ASR = overrides.ASR
	}
	if overrides.LLM.Value != nil {
		s.LLM = overrides.LLM
	}
	if overrides.TTS.Value != nil {
		s.TTS = overrides.TTS
	}
	if overrides.Persona != nil {
		s.Persona = *overrides.Persona
	}
	if overrides.Greeting != nil {
		s.Greeting = *overrides.Greeting
	}
	if overrides.FailureMessage != nil {
		s.FailureMessage = *overrides.FailureMessage
	}
	if overrides.SilenceMs != nil {
		s.SilenceMs = *overrides.SilenceMs
	}
	if overrides.InterruptMs != nil {
		s.InterruptMs = *overrides.InterruptMs
	}
	if overrides.IdleSeconds != nil {
		s.IdleSeconds = *overrides.IdleSeconds
	}
	return s
}

// Only what differs, as JSON.
func VoiceOverrides(defaults, settings VoiceSettings) SettingsUpdateVoice {
	differs := func(a, b any) bool {
		x, _ := json.Marshal(a)
		y, _ := json.Marshal(b)
		return string(x) != string(y)
	}
	var out SettingsUpdateVoice
	if differs(settings.Area, defaults.Area) {
		out.Area = &settings.Area
	}
	if differs(settings.Language, defaults.Language) {
		out.Language = &settings.Language
	}
	if differs(settings.ASR, defaults.ASR) {
		out.ASR = settings.ASR
	}
	if differs(settings.LLM, defaults.LLM) {
		out.LLM = settings.LLM
	}
	if differs(settings.TTS, defaults.TTS) {
		out.TTS = settings.TTS
	}
	if settings.Persona != defaults.Persona {
		out.Persona = &settings.Persona
	}
	if settings.Greeting != defaults.Greeting {
		out.Greeting = &settings.Greeting
	}
	if settings.FailureMessage != defaults.FailureMessage {
		out.FailureMessage = &settings.FailureMessage
	}
	if settings.SilenceMs != defaults.SilenceMs {
		out.SilenceMs = &settings.SilenceMs
	}
	if settings.InterruptMs != defaults.InterruptMs {
		out.InterruptMs = &settings.InterruptMs
	}
	if settings.IdleSeconds != defaults.IdleSeconds {
		out.IdleSeconds = &settings.IdleSeconds
	}
	return out
}
