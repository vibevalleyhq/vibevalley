package opencode

// Ported from tests/opencode/prompt-config.test.ts.

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/oar"
)

func jsonResult(t *testing.T, value any) executable.Result {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return ok(string(data))
}

func prepare(t *testing.T, options oar.SessionOptions, runner *recordingRunner) (PromptConfig, error) {
	t.Helper()
	prepared, err := PreparePrompts(context.Background(), "opencode", options, runner.run)
	if err == nil {
		t.Cleanup(prepared.Cleanup)
	}
	return prepared, err
}

func overlayOf(t *testing.T, options oar.SessionOptions) map[string]any {
	t.Helper()
	content := options.Env["OPENCODE_CONFIG_CONTENT"]
	if content == nil {
		t.Fatal("no OPENCODE_CONFIG_CONTENT")
	}
	var overlay map[string]any
	if err := json.Unmarshal([]byte(*content), &overlay); err != nil {
		t.Fatal(err)
	}
	return overlay
}

func TestOverrideQueriesNativeConfigInTheRequestedCwdAndTouchesOnlyTheSelectedAgentsPrompt(t *testing.T) {
	runner := &recordingRunner{results: []executable.Result{jsonResult(t, map[string]any{
		"default_agent": "scribe",
		"agent":         map[string]any{"scribe": map[string]any{"permission": map[string]any{"edit": "deny"}, "model": "kept"}, "build": map[string]any{"prompt": "kept"}},
		"instructions":  []any{"kept.md"},
	})}}
	prepared, err := prepare(t, oar.SessionOptions{Cwd: "/project", SystemPrompt: oar.String("literal {env:SECRET} and {file:secret.txt}"), Env: map[string]*string{"PROBE_ENV": oar.String("yes")}}, runner)
	if err != nil {
		t.Fatal(err)
	}
	call := runner.recorded()[0]
	if call.command != "opencode" || strings.Join(call.args, " ") != "debug config" || call.options.Dir != "/project" || call.options.Timeout != 30*time.Second {
		t.Fatalf("%+v", call)
	}
	if value, found := envValue(call.options.Env, "PROBE_ENV"); !found || value != "yes" {
		t.Fatal("PROBE_ENV not passed")
	}
	content := *prepared.Options.Env["OPENCODE_CONFIG_CONTENT"]
	if strings.Contains(content, "{env:") || strings.Contains(content, "{file:") {
		t.Fatal(content)
	}
	jsonEqual(t, overlayOf(t, prepared.Options), map[string]any{"agent": map[string]any{"scribe": map[string]any{"prompt": "literal {env:SECRET} and {file:secret.txt}"}}})
	if prepared.Agent != "scribe" {
		t.Fatal(prepared.Agent)
	}
}

func TestResumeUsesTheSavedAgentBeforeTheCurrentDefault(t *testing.T) {
	for _, c := range []struct {
		exported map[string]any
		expected string
	}{
		{map[string]any{"info": map[string]any{"agent": "saved"}, "messages": []any{}}, "saved"},
		{map[string]any{"info": map[string]any{}, "messages": []any{map[string]any{"info": map[string]any{"role": "user", "agent": "history", "model": map[string]any{"providerID": "p", "modelID": "m"}}}}}, "history"},
		{map[string]any{"info": map[string]any{}, "messages": []any{}}, "current"},
	} {
		t.Run(c.expected, func(t *testing.T) {
			runner := &recordingRunner{results: []executable.Result{
				jsonResult(t, map[string]any{"default_agent": "current", "agent": map[string]any{"current": map[string]any{}, "saved": map[string]any{}, "history": map[string]any{}}}),
				jsonResult(t, c.exported),
			}}
			prepared, err := prepare(t, oar.SessionOptions{Cwd: "/project", Resume: "ses_saved", SystemPrompt: oar.String("replacement")}, runner)
			if err != nil {
				t.Fatal(err)
			}
			if prepared.Agent != c.expected {
				t.Fatal(prepared.Agent)
			}
			if got := strings.Join(runner.recorded()[1].args, " "); got != "export ses_saved --sanitize" {
				t.Fatal(got)
			}
		})
	}
}

func TestAppendCreatesAPrivateSessionFileWithoutQueryingAgentsCleanupIsIdempotent(t *testing.T) {
	runner := &recordingRunner{}
	text := " appended {env:SECRET} \n"
	prepared, err := prepare(t, oar.SessionOptions{Cwd: "/project", AppendSystemPrompt: &text}, runner)
	if err != nil {
		t.Fatal(err)
	}
	if len(runner.recorded()) != 0 {
		t.Fatal("queried")
	}
	overlay := overlayOf(t, prepared.Options)
	instructions, _ := overlay["instructions"].([]any)
	file, isText := instructions[0].(string)
	if len(overlay) != 1 || !isText {
		t.Fatalf("%v", overlay)
	}
	data, err := os.ReadFile(file)
	if err != nil || string(data) != text {
		t.Fatalf("%q %v", data, err)
	}
	if info, err := os.Stat(file); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("%v %v", info, err)
	}
	var wait sync.WaitGroup
	for range 2 {
		wait.Add(1)
		go func() { defer wait.Done(); prepared.Cleanup() }()
	}
	wait.Wait()
	if _, err := os.Stat(file); !errors.Is(err, os.ErrNotExist) {
		t.Fatal(err)
	}
}

func TestExistingInlineConfigRefusesPromptsBeforeQueries(t *testing.T) {
	for _, option := range []string{"systemPrompt", "appendSystemPrompt"} {
		t.Run(option, func(t *testing.T) {
			runner := &recordingRunner{}
			given := oar.SessionOptions{Cwd: "/project"}
			if option == "systemPrompt" {
				given.SystemPrompt = oar.String("text")
			} else {
				given.AppendSystemPrompt = oar.String("text")
			}
			withInline := given
			withInline.Env = map[string]*string{"OPENCODE_CONFIG_CONTENT": oar.String("{}")}
			var unsupported *oar.UnsupportedOptionError
			if _, err := prepare(t, withInline, runner); !errors.As(err, &unsupported) || unsupported.Option != option {
				t.Fatalf("%v", err)
			}
			t.Setenv("OPENCODE_CONFIG_CONTENT", "")
			if _, err := prepare(t, given, runner); !errors.As(err, &unsupported) || unsupported.Option != option {
				t.Fatalf("%v", err)
			}
			if len(runner.recorded()) != 0 {
				t.Fatal("queried")
			}
			if err := ValidatePrompts(oar.SessionOptions{Cwd: "/project"}); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestEmptyReplacementCannotSilentlySelectBuiltInInstructions(t *testing.T) {
	err := ValidatePrompts(oar.SessionOptions{Cwd: "/", SystemPrompt: oar.String("")})
	if err == nil || !strings.Contains(err.Error(), "cannot replace the system prompt with an empty string") {
		t.Fatal(err)
	}
}

func TestModeReadBackRejectsADifferentOrMissingAgentNamingBothSides(t *testing.T) {
	if err := VerifyAgent(map[string]any{"configOptions": []any{map[string]any{"category": "mode", "currentValue": "scribe"}}}, "scribe"); err != nil {
		t.Fatal(err)
	}
	if err := VerifyAgent(map[string]any{"configOptions": []any{map[string]any{"category": "mode", "currentValue": "plan"}}}, "scribe"); err == nil || !strings.Contains(err.Error(), `selected agent "plan", but the system prompt was configured for "scribe"`) {
		t.Fatal(err)
	}
	if err := VerifyAgent(map[string]any{}, "scribe"); err == nil || !strings.Contains(err.Error(), `selected agent <unreported>, but the system prompt was configured for "scribe"`) {
		t.Fatal(err)
	}
}

func TestBadQueryOutputFailsWithoutCopyingConfigOrTranscriptContentsIntoTheError(t *testing.T) {
	runner := &recordingRunner{results: []executable.Result{ok("private malformed content")}}
	_, err := prepare(t, oar.SessionOptions{Cwd: "/", SystemPrompt: oar.String("base")}, runner)
	if err == nil || !strings.Contains(err.Error(), "opencode debug returned invalid JSON while resolving the session's agent") || strings.Contains(err.Error(), "private") {
		t.Fatal(err)
	}
}

func TestARemovedSavedAgentIsNeverRecreatedByThePromptOverlay(t *testing.T) {
	runner := &recordingRunner{results: []executable.Result{
		jsonResult(t, map[string]any{"default_agent": "build", "agent": map[string]any{}}),
		jsonResult(t, map[string]any{"info": map[string]any{"agent": "removed"}}),
	}}
	_, err := prepare(t, oar.SessionOptions{Cwd: "/", Resume: "ses_saved", SystemPrompt: oar.String("base")}, runner)
	var unsupported *oar.UnsupportedOptionError
	if !errors.As(err, &unsupported) || unsupported.Option != "systemPrompt" {
		t.Fatal(err)
	}
}

func TestRemovingInheritedInlineConfigPermitsPromptInjectionAndRemovesItFromEveryHelperQuery(t *testing.T) {
	t.Setenv("OPENCODE_CONFIG_CONTENT", "inherited-private-config")
	t.Setenv("OAR_ENV_REMOVE", "inherited-private-value")
	runner := &recordingRunner{results: []executable.Result{jsonResult(t, map[string]any{}), jsonResult(t, map[string]any{"info": map[string]any{"agent": "build"}})}}
	prepared, err := prepare(t, oar.SessionOptions{
		Cwd: "/project", Resume: "old", SystemPrompt: oar.String("replacement"),
		Env: map[string]*string{"OPENCODE_CONFIG_CONTENT": nil, "OAR_ENV_REMOVE": nil, "OAR_ENV_OVERRIDE": oar.String("new")},
	}, runner)
	if err != nil {
		t.Fatal(err)
	}
	if calls := runner.recorded(); len(calls) != 2 {
		t.Fatalf("%d calls", len(calls))
	}
	for _, call := range runner.recorded() {
		if _, found := envValue(call.options.Env, "OPENCODE_CONFIG_CONTENT"); found {
			t.Fatal("OPENCODE_CONFIG_CONTENT reached a helper query")
		}
		if _, found := envValue(call.options.Env, "OAR_ENV_REMOVE"); found {
			t.Fatal("OAR_ENV_REMOVE reached a helper query")
		}
		if value, _ := envValue(call.options.Env, "OAR_ENV_OVERRIDE"); value != "new" {
			t.Fatal(value)
		}
	}
	if value, present := prepared.Options.Env["OAR_ENV_REMOVE"]; !present || value != nil {
		t.Fatal("the removal was not kept")
	}
	jsonEqual(t, overlayOf(t, prepared.Options), map[string]any{"agent": map[string]any{"build": map[string]any{"prompt": "replacement"}}})
	if os.Getenv("OPENCODE_CONFIG_CONTENT") != "inherited-private-config" {
		t.Fatal("the host environment changed")
	}
}
