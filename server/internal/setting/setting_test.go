package setting

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/agora"
	"vibevalley/pkg/x/ptr"
)

const (
	voiceTestAppID = "11111111111111111111111111111111"
	voiceTestCert  = "22222222222222222222222222222222"
)

func settingsAt(home string, change ...func(*base.Config)) *Service {
	cfg := fixture.Config(home, "", "")
	for _, f := range change {
		f(&cfg)
	}
	return New(cfg)
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
	s := settingsAt(home, func(c *base.Config) { c.DeepSeek.APIKey = "sk-from-the-env-0000" })
	before := s.Status()
	voiceSame(t, before.DeepseekAPIKey, voiceHint(protocol.KeySourceConfig, "…0000"), "the configuration's key")
	voiceSame(t, before.AgoraAppID, protocol.AgoraAppID{}, "no app id")
	after, err := s.Save(protocol.SettingsUpdate{DeepseekAPIKey: ptr.To(" sk-saved-in-settings-1234 "), AgoraAppID: ptr.To(voiceTestAppID), AgoraAppCertificate: ptr.To(voiceTestCert)})
	if err != nil {
		t.Fatal(err)
	}
	voiceSame(t, after.DeepseekAPIKey, voiceHint(protocol.KeySourceSettings, "…1234"), "settings win over the configuration")
	voiceSame(t, after.AgoraAppID, protocol.AgoraAppID{Source: ptr.To(protocol.KeySourceSettings), Value: ptr.To(voiceTestAppID)}, "app id")
	voiceSame(t, after.AgoraAppCertificate, voiceHint(protocol.KeySourceSettings, keyHint(voiceTestCert)), "certificate")
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

	cleared, err := s.Save(protocol.SettingsUpdate{DeepseekAPIKey: ptr.To("")})
	if err != nil {
		t.Fatal(err)
	}
	voiceSame(t, cleared.DeepseekAPIKey, voiceHint(protocol.KeySourceConfig, "…0000"), "cleared")
	if cleared.AgoraAppID.Value == nil || *cleared.AgoraAppID.Value != voiceTestAppID {
		t.Fatal("the app id stays")
	}
	if body, _ := os.ReadFile(file); strings.Contains(string(body), "deepseekApiKey") {
		t.Fatal("a cleared key leaves the file")
	}
	again := settingsAt(home)
	if got := again.Agora(); got == nil || got.AppID != voiceTestAppID {
		t.Fatalf("read back: %+v", got)
	}
}

func TestSettingsRefuseWhatCannotBeRight(t *testing.T) {
	s := settingsAt(t.TempDir())
	if _, err := s.Save(protocol.SettingsUpdate{AgoraAppID: ptr.To("not-an-app-id")}); err == nil || !strings.Contains(err.Error(), "App ID") {
		t.Fatalf("refused: %v", err)
	}
	if s.Agora() != nil {
		t.Fatal("nothing saved")
	}
	if _, err := os.Stat(s.file); !os.IsNotExist(err) {
		t.Fatal("no file written")
	}
}

func TestSettingsVoiceKeepsOnlyWhatDiffers(t *testing.T) {
	home := t.TempDir()
	s := settingsAt(home, func(c *base.Config) { c.Voice.Model, c.Voice.ID = "gpt-5-mini", "English_captivating_female1" })
	before := s.Status()
	voiceSame(t, before.VoiceDefaults.Answer, protocol.VoiceAnswer{Value: protocol.VoiceAnswerAgora{Model: "gpt-5-mini"}}, "the configuration's model")
	voiceSame(t, before.VoiceDefaults.TTS, protocol.VoiceTTS{Value: protocol.VoiceTTSMinimax{Model: "speech_2_6_turbo", VoiceID: "English_captivating_female1"}}, "the configuration's voice")
	if before.VoiceDefaults.Greeting != protocol.DefaultVoice().Greeting {
		t.Fatal("greeting")
	}
	voiceSame(t, before.Voice, before.VoiceDefaults, "nothing changed")

	wanted := before.VoiceDefaults
	wanted.Area, wanted.SilenceMs, wanted.Greeting = protocol.AreaCN, 600, "在呢。"
	overrides := voiceOverrides(before.VoiceDefaults, wanted)
	after, err := s.Save(protocol.SettingsUpdate{Voice: &overrides})
	if err != nil {
		t.Fatal(err)
	}
	voiceSame(t, after.Voice, wanted, "saved")
	voiceSame(t, s.Voice(), wanted, "the next call uses them")
	file := filepath.Join(home, "settings.json")
	voiceSame(t, voiceReadSettings(file).Voice, map[string]any{"area": "CN", "silenceMs": 600, "greeting": "在呢。"}, "only what differs")
	// The page sends the voice whole: what equals the defaults is left out all the same.
	whole := voiceOverrides(protocol.VoiceSettings{}, wanted)
	if _, err := s.Save(protocol.SettingsUpdate{Voice: &whole}); err != nil {
		t.Fatal(err)
	}
	voiceSame(t, voiceReadSettings(file).Voice, map[string]any{"area": "CN", "silenceMs": 600, "greeting": "在呢。"}, "whole, only what differs")
	testkit.Eq(t, s.Check(protocol.SettingsUpdate{Voice: &protocol.SettingsUpdateVoice{Persona: ptr.To("  ")}}).Problem != "", true, "check says what save would refuse")

	if _, err := s.Save(protocol.SettingsUpdate{AgoraAppID: ptr.To(voiceTestAppID)}); err != nil {
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
	if _, err := s.Save(protocol.SettingsUpdate{Voice: &protocol.SettingsUpdateVoice{SilenceMs: ptr.To(int64(50))}}); err == nil || !strings.Contains(err.Error(), "200 到 2000") {
		t.Fatalf("out of range: %v", err)
	}
	if _, err := s.Save(protocol.SettingsUpdate{Voice: &protocol.SettingsUpdateVoice{Persona: ptr.To("  ")}}); err == nil || !strings.Contains(err.Error(), "人设") {
		t.Fatalf("empty persona: %v", err)
	}
}

func TestSettingsVoiceVendorKeysAreHints(t *testing.T) {
	home := t.TempDir()
	s := settingsAt(home)
	before := s.Status()
	voiceSame(t, before.TTSKey, protocol.KeyStatus{}, "no key")
	wanted := before.VoiceDefaults
	wanted.TTS = protocol.VoiceTTS{Value: protocol.VoiceTTSMicrosoft{Region: "eastasia", VoiceName: "zh-CN-XiaoxiaoNeural"}}
	overrides := voiceOverrides(before.VoiceDefaults, wanted)
	after, err := s.Save(protocol.SettingsUpdate{Voice: &overrides, TTSKey: ptr.To(" azure-speech-key-9f3a ")})
	if err != nil {
		t.Fatal(err)
	}
	voiceSame(t, after.Voice.TTS, wanted.TTS, "the vendor")
	voiceSame(t, after.TTSKey, voiceHint(protocol.KeySourceSettings, "…9f3a"), "its key, as a hint")
	if body, _ := json.Marshal(after); strings.Contains(string(body), "azure-speech-key") {
		t.Fatal("the key itself never goes to a page")
	}
	if got := s.VoiceConfig().Keys; !reflect.DeepEqual(got, VoiceKeys{TTSKey: "azure-speech-key-9f3a"}) {
		t.Fatalf("keys: %+v", got)
	}
	voiceSame(t, voiceReadSettings(filepath.Join(home, "settings.json")).Voice, map[string]any{"tts": map[string]any{"vendor": "microsoft", "region": "eastasia", "voiceName": "zh-CN-XiaoxiaoNeural"}}, "the file")
	bad := protocol.SettingsUpdateVoice{Answer: protocol.VoiceAnswer{Value: protocol.VoiceAnswerOpenai{URL: "not a url", Model: "x"}}}
	if _, err := s.Save(protocol.SettingsUpdate{Voice: &bad}); err == nil || !strings.Contains(err.Error(), "http") {
		t.Fatalf("bad url: %v", err)
	}
}

func TestMemorySourcesKeepTheirKeyUntilCleared(t *testing.T) {
	home := t.TempDir()
	s := settingsAt(home)
	if got := s.Status().MemorySources; got == nil || len(got) != 0 {
		t.Fatalf("none yet: %#v", got)
	}
	nowledge := protocol.MemorySourceUpdate{Kind: protocol.MemorySourceKindNowledge, URL: " http://127.0.0.1:14242/mcp/ ", Enabled: true, Read: true, Write: true, Key: ptr.To("nmem-secret-9876")}
	after, err := s.Save(protocol.SettingsUpdate{MemorySources: []protocol.MemorySourceUpdate{nowledge}})
	if err != nil {
		t.Fatal(err)
	}
	voiceSame(t, after.MemorySources[0].Key, voiceHint(protocol.KeySourceSettings, "…9876"), "only the key's end is shown")
	nowledge.Key, nowledge.Write = nil, false
	if _, err := s.Save(protocol.SettingsUpdate{MemorySources: []protocol.MemorySourceUpdate{nowledge}}); err != nil {
		t.Fatal(err)
	}
	got := settingsAt(home).MemorySources()
	if len(got) != 1 || got[0].Key != "nmem-secret-9876" || got[0].URL != "http://127.0.0.1:14242/mcp/" || got[0].Write {
		t.Fatalf("saved %+v", got)
	}
	if _, err := s.Save(protocol.SettingsUpdate{DeepseekAPIKey: ptr.To("sk-other-key-0000")}); err != nil || len(s.MemorySources()) != 1 {
		t.Fatalf("an update without the list keeps it: %v", err)
	}
	if _, err := s.Save(protocol.SettingsUpdate{MemorySources: []protocol.MemorySourceUpdate{}}); err != nil || len(s.MemorySources()) != 0 {
		t.Fatalf("an empty list clears it: %v", err)
	}
}

func TestMemorySourcesProblem(t *testing.T) {
	on := protocol.MemorySourceUpdate{Kind: protocol.MemorySourceKindNowledge, URL: "http://127.0.0.1:14242/mcp/", Enabled: true}
	testkit.Eq(t, memorySourcesProblem([]protocol.MemorySourceUpdate{on}), "")
	testkit.Match(t, memorySourcesProblem([]protocol.MemorySourceUpdate{on, on}), "只能接一个")
	testkit.Match(t, memorySourcesProblem([]protocol.MemorySourceUpdate{{Kind: "mem0"}}), "不认识")
	testkit.Match(t, memorySourcesProblem([]protocol.MemorySourceUpdate{{Kind: protocol.MemorySourceKindNowledge, Enabled: true}}), "先填它的地址")
	testkit.Match(t, memorySourcesProblem([]protocol.MemorySourceUpdate{{Kind: protocol.MemorySourceKindNowledge, URL: "127.0.0.1:14242"}}), "http")
	testkit.Match(t, settingsProblem(protocol.SettingsUpdate{MemorySources: []protocol.MemorySourceUpdate{{Kind: protocol.MemorySourceKindNowledge, Key: ptr.To("a b")}}}), "空格")
}
