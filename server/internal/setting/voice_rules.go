package setting

import (
	"encoding/json"
	"fmt"
	"regexp"

	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/str"
)

type voiceLimit struct{ Min, Max int64 }

var voiceLimits = map[string]voiceLimit{
	"silenceMs":   {Min: protocol.VoiceSilenceMsMin, Max: protocol.VoiceSilenceMsMax},
	"interruptMs": {Min: protocol.VoiceInterruptMsMin, Max: protocol.VoiceInterruptMsMax},
	"idleSeconds": {Min: protocol.VoiceIdleSecondsMin, Max: protocol.VoiceIdleSecondsMax},
}

var voiceFieldLabel = map[string]string{
	"area":           "区域",
	"language":       "语言",
	"asr":            "识别",
	"answer":         "谁接电话",
	"tts":            "合成",
	"persona":        "人设",
	"greeting":       "开场白",
	"failureMessage": "出错时说",
	"silenceMs":      "停顿多久算说完（毫秒）",
	"interruptMs":    "说多久能打断他（毫秒）",
	"idleSeconds":    "没人时多久离开（秒）",
}

var voiceURL = regexp.MustCompile(`^https?://[^` + str.SpaceClass + `]+$`)

func voiceProblem(v protocol.SettingsUpdateVoice) string {
	if asr, ok := v.ASR.Value.(protocol.VoiceASRMicrosoft); ok && str.Trim(asr.Region) == "" {
		return "微软识别要填区域，比如 eastasia"
	}
	switch llm := v.Answer.Value.(type) {
	case protocol.VoiceAnswerDeepseek:
		if str.Trim(llm.Model) == "" {
			return "大模型要填模型名"
		}
	case protocol.VoiceAnswerOpenai:
		if str.Trim(llm.Model) == "" {
			return "大模型要填模型名"
		}
		if !voiceURL.MatchString(str.Trim(llm.URL)) {
			return "大模型的地址要是 http(s) 开头的完整地址，比如 https://api.openai.com/v1/chat/completions"
		}
	}
	switch tts := v.TTS.Value.(type) {
	case protocol.VoiceTTSMinimax:
		if str.Trim(tts.VoiceID) == "" {
			return "音色不能空着：选一个或填 MiniMax 的音色 id"
		}
	case protocol.VoiceTTSMicrosoft:
		if str.Trim(tts.Region) == "" || str.Trim(tts.VoiceName) == "" {
			return "微软合成要填区域和音色名"
		}
	}
	if v.Persona != nil && str.Trim(*v.Persona) == "" {
		return "管家的人设不能空着"
	}
	for _, f := range []struct {
		key string
		n   *int64
	}{{"silenceMs", v.SilenceMs}, {"interruptMs", v.InterruptMs}, {"idleSeconds", v.IdleSeconds}} {
		limit := voiceLimits[f.key]
		if f.n != nil && (*f.n < limit.Min || *f.n > limit.Max) {
			return fmt.Sprintf("%s要在 %d 到 %d 之间", voiceFieldLabel[f.key], limit.Min, limit.Max)
		}
	}
	return ""
}

func voiceSettingsOver(defaults protocol.VoiceSettings, overrides protocol.SettingsUpdateVoice) protocol.VoiceSettings {
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
	if overrides.Answer.Value != nil {
		s.Answer = overrides.Answer
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
func voiceOverrides(defaults, settings protocol.VoiceSettings) protocol.SettingsUpdateVoice {
	differs := func(a, b any) bool {
		x, _ := json.Marshal(a)
		y, _ := json.Marshal(b)
		return string(x) != string(y)
	}
	var out protocol.SettingsUpdateVoice
	if differs(settings.Area, defaults.Area) {
		out.Area = &settings.Area
	}
	if differs(settings.Language, defaults.Language) {
		out.Language = &settings.Language
	}
	if differs(settings.ASR, defaults.ASR) {
		out.ASR = settings.ASR
	}
	if differs(settings.Answer, defaults.Answer) {
		out.Answer = settings.Answer
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
