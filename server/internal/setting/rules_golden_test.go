package setting

import (
	"testing"

	"vibevalley/internal/golden"
	"vibevalley/internal/protocol"
)

// The settings' and the voice's checks over their recorded cases (testdata/rules.jsonl.gz).
func TestRulesGolden(t *testing.T) {
	seen := golden.Rules(t, "testdata/rules.jsonl.gz", func(c golden.Case) any {
		switch c.Fn {
		case "settingsProblem":
			var u protocol.SettingsUpdate
			c.Decode(t, c.In, &u)
			return golden.Null(settingsProblem(u))
		case "voiceProblem":
			var v protocol.SettingsUpdateVoice
			c.Decode(t, c.In, &v)
			return golden.Null(voiceProblem(v))
		case "voiceOverrides":
			var settings protocol.VoiceSettings
			c.Decode(t, c.In, &settings)
			var want struct {
				Overrides protocol.SettingsUpdateVoice `json:"overrides"`
			}
			c.Decode(t, c.Out, &want)
			return map[string]any{"overrides": voiceOverrides(protocol.DefaultVoice(), settings), "settings": voiceSettingsOver(protocol.DefaultVoice(), want.Overrides)}
		case "keyHint":
			var s string
			c.Decode(t, c.In, &s)
			return keyHint(s)
		}
		t.Fatalf("line %d: unknown fn %q", c.Line, c.Fn)
		return nil
	})
	if len(seen) != 4 {
		t.Fatalf("rules seen: %v", seen)
	}
}
