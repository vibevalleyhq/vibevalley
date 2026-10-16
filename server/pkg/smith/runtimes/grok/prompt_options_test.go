package grok

// Ported from tests/grok/grok-prompt-options.test.ts.

import (
	"context"
	"errors"
	"testing"

	"vibevalley/pkg/smith/oar"
)

func TestBothInstructionsReachOneOverride(t *testing.T) {
	for _, resume := range []string{"", "saved-session"} {
		jsonEqual(t, InitializeMeta(oar.SessionOptions{Cwd: "/", Resume: resume, SystemPrompt: oar.String("base"), AppendSystemPrompt: oar.String("extra")}), map[string]any{
			"clientIdentifier":     "oar",
			"clientType":           "generic",
			"startupHints":         map[string]any{"nonInteractive": true, "skipGitStatus": true, "skipProjectLayout": true},
			"systemPromptOverride": "base\n\nextra",
		}, "resume=", resume)
	}
}

func TestAppendAloneIsRefusedBeforeLaunchOnResume(t *testing.T) {
	_, err := Session(context.Background(), oar.AvailableInstallation{Via: "executable", Command: "oar-must-not-spawn"}, oar.SessionOptions{Cwd: "/", Resume: "saved-session", AppendSystemPrompt: oar.String("extra")})
	var unsupported *oar.UnsupportedOptionError
	if !errors.As(err, &unsupported) || unsupported.Option != "appendSystemPrompt" || unsupported.Message != "grok does not reapply rules when resuming a session (observed on 1.0.46)" {
		t.Fatalf("%#v", err)
	}
}

func TestIndividualNewSessionInstructionChannelsStayDistinct(t *testing.T) {
	if got := InitializeMeta(oar.SessionOptions{Cwd: "/", SystemPrompt: oar.String("base")})["systemPromptOverride"]; got != "base" {
		t.Fatal(got)
	}
	if got := InitializeMeta(oar.SessionOptions{Cwd: "/", AppendSystemPrompt: oar.String("extra")})["rules"]; got != "extra" {
		t.Fatal(got)
	}
	if got := InitializeMeta(oar.SessionOptions{Cwd: "/", Resume: "saved-session", SystemPrompt: oar.String("replacement")})["systemPromptOverride"]; got != "replacement" {
		t.Fatal(got)
	}
}
