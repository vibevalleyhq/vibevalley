package setting

import (
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/pkg/x/ptr"
)

func TestSettingsProblem(t *testing.T) {
	testkit.Match(t, settingsProblem(protocol.SettingsUpdate{DeepseekAPIKey: ptr.To("sk has spaces")}), "DeepSeek")
	testkit.Match(t, settingsProblem(protocol.SettingsUpdate{AgoraAppCertificate: ptr.To("123")}), "Certificate")
	testkit.Match(t, settingsProblem(protocol.SettingsUpdate{AgoraAppID: ptr.To("not-an-app-id")}), "App ID")
	testkit.Eq(t, settingsProblem(protocol.SettingsUpdate{DeepseekAPIKey: ptr.To(""), AgoraAppID: ptr.To("")}), "", "clearing is always fine")
	testkit.Eq(t, settingsProblem(protocol.SettingsUpdate{AgoraAppID: ptr.To("0123456789ABCDEF0123456789abcdef"), DeepseekAPIKey: ptr.To(" sk-12345678 ")}), "")
	testkit.Match(t, settingsProblem(protocol.SettingsUpdate{TTSKey: ptr.To(" a b ")}), "空格")
	testkit.Match(t, settingsProblem(protocol.SettingsUpdate{Voice: &protocol.SettingsUpdateVoice{SilenceMs: ptr.To[int64](50)}}), "200 到 2000")
	testkit.Match(t, settingsProblem(protocol.SettingsUpdate{Voice: &protocol.SettingsUpdateVoice{Persona: ptr.To("  ")}}), "人设")
	testkit.Match(t, settingsProblem(protocol.SettingsUpdate{Voice: &protocol.SettingsUpdateVoice{LLM: protocol.VoiceLLM{Value: protocol.VoiceLLMOpenai{URL: "not a url", Model: "x"}}}}), "http")
	testkit.Eq(t, keyHint("sk-saved-in-settings-1234"), "…1234")
	testkit.Eq(t, keyHint("ab"), "…ab")
}

func TestVoiceOverrides(t *testing.T) {
	defaults := protocol.DefaultVoice()
	wanted := defaults
	wanted.Area, wanted.SilenceMs, wanted.Greeting = protocol.AreaCN, 600, "在呢。"
	over := voiceOverrides(defaults, wanted)
	testkit.Eq(t, over, protocol.SettingsUpdateVoice{Area: ptr.To(protocol.AreaCN), SilenceMs: ptr.To[int64](600), Greeting: ptr.To("在呢。")})
	testkit.Eq(t, voiceSettingsOver(defaults, over), wanted)
	testkit.Eq(t, voiceSettingsOver(defaults, protocol.SettingsUpdateVoice{}), defaults)
	tts := protocol.VoiceTTS{Value: protocol.VoiceTTSMicrosoft{Region: "eastasia", VoiceName: "zh-CN-XiaoxiaoNeural"}}
	wanted = defaults
	wanted.TTS = tts
	testkit.Eq(t, voiceOverrides(defaults, wanted), protocol.SettingsUpdateVoice{TTS: tts})
}
