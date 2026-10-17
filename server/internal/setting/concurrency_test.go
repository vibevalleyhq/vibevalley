package setting

import (
	"sync"
	"testing"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/x/ptr"
)

func TestConcurrentPartialSavesKeepEveryField(t *testing.T) {
	for range 20 {
		home := t.TempDir()
		s := settingsAt(home)
		updates := []protocol.SettingsUpdate{
			{DeepseekAPIKey: ptr.To("deepseek-value")},
			{ASRKey: ptr.To("asr-value")},
			{LLMKey: ptr.To("llm-value")},
			{TTSKey: ptr.To("tts-value")},
		}
		start := make(chan struct{})
		var wg sync.WaitGroup
		for _, u := range updates {
			wg.Go(func() {
				<-start
				if _, err := s.Save(u); err != nil {
					t.Error(err)
				}
			})
		}
		close(start)
		wg.Wait()
		for _, saved := range []*Service{s, settingsAt(home)} {
			keys := saved.VoiceConfig().Keys
			if saved.DeepseekAPIKey() != "deepseek-value" || keys.ASRKey != "asr-value" || keys.LLMKey != "llm-value" || keys.TTSKey != "tts-value" {
				t.Fatalf("partial saves lost fields: %+v", keys)
			}
		}
	}
}

func TestVoiceConfigReadsProviderAndKeysFromOneRevision(t *testing.T) {
	s := settingsAt(t.TempDir())
	for _, key := range []string{"sk-first-value", "sk-second-value"} {
		if _, err := s.Save(protocol.SettingsUpdate{DeepseekAPIKey: &key, TTSKey: &key, Voice: &protocol.SettingsUpdateVoice{Greeting: &key}}); err != nil {
			t.Fatal(err)
		}
		snapshot := s.VoiceConfig()
		if snapshot.DeepseekAPIKey != key || snapshot.Keys.TTSKey != key || snapshot.Voice.Greeting != key {
			t.Fatalf("mixed voice config: %+v", snapshot)
		}
	}
}
