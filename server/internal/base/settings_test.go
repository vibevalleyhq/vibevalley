package base

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"vibevalley/internal/farmtest"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/agora"
)

const (
	voiceTestAppID = "11111111111111111111111111111111"
	voiceTestCert  = "22222222222222222222222222222222"
)

func voiceEnv(env map[string]string) func(string) string {
	return func(name string) string { return env[name] }
}

func voiceHint(source protocol.KeySource, hint string) protocol.KeyStatus {
	return protocol.KeyStatus{Source: &source, Hint: &hint}
}

func voiceSame(t *testing.T, got, want any, what string) {
	t.Helper()
	a, _ := json.Marshal(got)
	b, _ := json.Marshal(want)
	var x, y any
	json.Unmarshal(a, &x)
	json.Unmarshal(b, &y)
	if !reflect.DeepEqual(x, y) {
		t.Fatalf("%s:\n got  %s\n want %s", what, a, b)
	}
}

func TestSettingsKeysAreYoursAlone(t *testing.T) {
	home := t.TempDir()
	s := NewSettingsFrom(home, filepath.Join(home, "no-pi.json"), voiceEnv(map[string]string{"DEEPSEEK_API_KEY": "sk-from-the-env-0000"}))
	before := s.Status()
	voiceSame(t, before.DeepseekAPIKey, voiceHint(protocol.KeySourceEnv, "…0000"), "the environment's key")
	voiceSame(t, before.AgoraAppID, protocol.AgoraAppID{}, "no app id")
	after, err := s.Save(protocol.SettingsUpdate{DeepseekAPIKey: farmtest.Ptr(" sk-saved-in-settings-1234 "), AgoraAppID: farmtest.Ptr(voiceTestAppID), AgoraAppCertificate: farmtest.Ptr(voiceTestCert)})
	if err != nil {
		t.Fatal(err)
	}
	voiceSame(t, after.DeepseekAPIKey, voiceHint(protocol.KeySourceSettings, "…1234"), "settings win over the environment")
	voiceSame(t, after.AgoraAppID, protocol.AgoraAppID{Source: farmtest.Ptr(protocol.KeySourceSettings), Value: farmtest.Ptr(voiceTestAppID)}, "app id")
	voiceSame(t, after.AgoraAppCertificate, voiceHint(protocol.KeySourceSettings, protocol.KeyHint(voiceTestCert)), "certificate")
	if body, _ := json.Marshal(after); strings.Contains(string(body), "sk-saved") {
		t.Fatal("the key itself never goes to a page")
	}
	if s.DeepseekAPIKey() != "sk-saved-in-settings-1234" {
		t.Fatal(s.DeepseekAPIKey())
	}
	if got := s.Agora(); got == nil || *got != (agora.Credentials{AppID: voiceTestAppID, AppCertificate: voiceTestCert}) {
		t.Fatalf("agora: %+v", got)
	}
	file := filepath.Join(home, "settings.json")
	info, err := os.Stat(file)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("mode %o", info.Mode().Perm())
	}
	voiceSame(t, voiceReadSettings(file), voiceStored{DeepseekAPIKey: "sk-saved-in-settings-1234", AgoraAppID: voiceTestAppID, AgoraAppCertificate: voiceTestCert}, "the file")

	cleared, err := s.Save(protocol.SettingsUpdate{DeepseekAPIKey: farmtest.Ptr("")})
	if err != nil {
		t.Fatal(err)
	}
	voiceSame(t, cleared.DeepseekAPIKey, voiceHint(protocol.KeySourceEnv, "…0000"), "cleared")
	if cleared.AgoraAppID.Value == nil || *cleared.AgoraAppID.Value != voiceTestAppID {
		t.Fatal("the app id stays")
	}
	if body, _ := os.ReadFile(file); strings.Contains(string(body), "deepseekApiKey") {
		t.Fatal("a cleared key leaves the file")
	}
	again := NewSettingsFrom(home, "", voiceEnv(nil))
	if got := again.Agora(); got == nil || got.AppID != voiceTestAppID {
		t.Fatalf("read back: %+v", got)
	}
}

func TestSettingsRefuseWhatCannotBeRight(t *testing.T) {
	s := NewSettingsFrom(t.TempDir(), "", voiceEnv(nil))
	if _, err := s.Save(protocol.SettingsUpdate{AgoraAppID: farmtest.Ptr("not-an-app-id")}); err == nil || !strings.Contains(err.Error(), "App ID") {
		t.Fatalf("refused: %v", err)
	}
	if s.Agora() != nil {
		t.Fatal("nothing saved")
	}
	if _, err := os.Stat(s.file); !os.IsNotExist(err) {
		t.Fatal("no file written")
	}
}

func TestSettingsDeepseekFromPi(t *testing.T) {
	home := t.TempDir()
	pi := filepath.Join(home, "models.json")
	os.WriteFile(pi, []byte(`{"providers":{"deepseek":{"apiKey":"$PI_DEEPSEEK"}}}`), 0o600)
	s := NewSettingsFrom(home, pi, voiceEnv(map[string]string{"PI_DEEPSEEK": "sk-pi-named-5678"}))
	voiceSame(t, s.Status().DeepseekAPIKey, voiceHint(protocol.KeySourcePi, "…5678"), "pi's key, through the variable it names")
	if s.DeepseekAPIKey() != "" {
		t.Fatal("pi's key is not the farm's own")
	}
	if s.VoiceDeepseekKey() != "sk-pi-named-5678" {
		t.Fatal("the voice falls back to pi's")
	}
	os.WriteFile(pi, []byte(`{"providers":{"deepseek":{"apiKey":"sk-pi-plain-9999"}}}`), 0o600)
	voiceSame(t, s.Status().DeepseekAPIKey, voiceHint(protocol.KeySourcePi, "…9999"), "pi's key as it is")
}

func TestSettingsVoiceKeepsOnlyWhatDiffers(t *testing.T) {
	home := t.TempDir()
	s := NewSettingsFrom(home, "", voiceEnv(map[string]string{"VIBEVALLEY_VOICE_MODEL": "gpt-5-mini", "VIBEVALLEY_VOICE_ID": "English_captivating_female1"}))
	before := s.Status()
	voiceSame(t, before.VoiceDefaults.LLM, protocol.VoiceLLM{Value: protocol.VoiceLLMAgora{Model: "gpt-5-mini"}}, "the environment's model")
	voiceSame(t, before.VoiceDefaults.TTS, protocol.VoiceTTS{Value: protocol.VoiceTTSMinimax{Model: "speech_2_6_turbo", VoiceID: "English_captivating_female1"}}, "the environment's voice")
	if before.VoiceDefaults.Greeting != protocol.DefaultVoice().Greeting {
		t.Fatal("greeting")
	}
	voiceSame(t, before.Voice, before.VoiceDefaults, "nothing changed")

	wanted := before.VoiceDefaults
	wanted.Area, wanted.SilenceMs, wanted.Greeting = protocol.AreaCN, 600, "在呢。"
	overrides := protocol.VoiceOverrides(before.VoiceDefaults, wanted)
	after, err := s.Save(protocol.SettingsUpdate{Voice: &overrides})
	if err != nil {
		t.Fatal(err)
	}
	voiceSame(t, after.Voice, wanted, "saved")
	voiceSame(t, s.Voice(), wanted, "the next call uses them")
	file := filepath.Join(home, "settings.json")
	voiceSame(t, voiceReadSettings(file).Voice, map[string]any{"area": "CN", "silenceMs": 600, "greeting": "在呢。"}, "only what differs")

	if _, err := s.Save(protocol.SettingsUpdate{AgoraAppID: farmtest.Ptr(voiceTestAppID)}); err != nil {
		t.Fatal(err)
	}
	if s.Voice().Area != protocol.AreaCN {
		t.Fatal("the voice stays")
	}
	reset, err := s.Save(protocol.SettingsUpdate{Voice: &protocol.SettingsUpdateVoice{}})
	if err != nil {
		t.Fatal(err)
	}
	voiceSame(t, reset.Voice, reset.VoiceDefaults, "reset")
	if voiceReadSettings(file).Voice != nil {
		t.Fatal("reset leaves the file")
	}
	if _, err := s.Save(protocol.SettingsUpdate{Voice: &protocol.SettingsUpdateVoice{SilenceMs: farmtest.Ptr(int64(50))}}); err == nil || !strings.Contains(err.Error(), "200 到 2000") {
		t.Fatalf("out of range: %v", err)
	}
	if _, err := s.Save(protocol.SettingsUpdate{Voice: &protocol.SettingsUpdateVoice{Persona: farmtest.Ptr("  ")}}); err == nil || !strings.Contains(err.Error(), "人设") {
		t.Fatalf("empty persona: %v", err)
	}
}

func TestSettingsVoiceVendorKeysAreHints(t *testing.T) {
	home := t.TempDir()
	s := NewSettingsFrom(home, "", voiceEnv(nil))
	before := s.Status()
	voiceSame(t, before.TTSKey, protocol.KeyStatus{}, "no key")
	wanted := before.VoiceDefaults
	wanted.TTS = protocol.VoiceTTS{Value: protocol.VoiceTTSMicrosoft{Region: "eastasia", VoiceName: "zh-CN-XiaoxiaoNeural"}}
	overrides := protocol.VoiceOverrides(before.VoiceDefaults, wanted)
	after, err := s.Save(protocol.SettingsUpdate{Voice: &overrides, TTSKey: farmtest.Ptr(" azure-speech-key-9f3a ")})
	if err != nil {
		t.Fatal(err)
	}
	voiceSame(t, after.Voice.TTS, wanted.TTS, "the vendor")
	voiceSame(t, after.TTSKey, voiceHint(protocol.KeySourceSettings, "…9f3a"), "its key, as a hint")
	if body, _ := json.Marshal(after); strings.Contains(string(body), "azure-speech-key") {
		t.Fatal("the key itself never goes to a page")
	}
	if got := s.VoiceKeys(); !reflect.DeepEqual(got, VoiceKeys{TTSKey: "azure-speech-key-9f3a"}) {
		t.Fatalf("keys: %+v", got)
	}
	voiceSame(t, voiceReadSettings(filepath.Join(home, "settings.json")).Voice, map[string]any{"tts": map[string]any{"vendor": "microsoft", "region": "eastasia", "voiceName": "zh-CN-XiaoxiaoNeural"}}, "the file")
	bad := protocol.SettingsUpdateVoice{LLM: protocol.VoiceLLM{Value: protocol.VoiceLLMOpenai{URL: "not a url", Model: "x"}}}
	if _, err := s.Save(protocol.SettingsUpdate{Voice: &bad}); err == nil || !strings.Contains(err.Error(), "http") {
		t.Fatalf("bad url: %v", err)
	}
}
