package opencode

// This runtime's cases of tests/refused-session-options.test.ts: every
// declared refusal is what Session rejects with, before anything starts.

import (
	"context"
	"encoding/json"
	"errors"
	"slices"
	"testing"

	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/oar"
)

// givenOption is a SessionOptions that gives option.
func givenOption(option oar.RefusableSessionOption) oar.SessionOptions {
	options := oar.SessionOptions{Cwd: "/tmp"}
	switch option {
	case oar.OptionAdditionalDirectories:
		options.AdditionalDirectories = []string{"/extra"}
	case oar.OptionOutputSchema:
		options.OutputSchema = json.RawMessage("{}")
	case oar.OptionServiceTier:
		options.ServiceTier = "fast"
	case oar.OptionDisallowedTools:
		options.DisallowedTools = []string{"native_tool"}
	case oar.OptionSystemPrompt:
		options.SystemPrompt = oar.String("x")
	case oar.OptionAppendSystemPrompt:
		options.AppendSystemPrompt = oar.String("x")
	case oar.OptionEnv:
		options.Env = map[string]*string{"OAR_PROBE": oar.String("1")}
	case oar.OptionMCPServers:
		options.MCPServers = []oar.McpServer{{Name: "probe", Command: "/nonexistent/oar-probe"}}
	case oar.OptionLaunchArgs:
		options.LaunchArgs = []string{"--probe"}
	case oar.OptionName:
		options.Name = oar.String("probe")
	}
	return options
}

var nowhere = oar.AvailableInstallation{Via: "executable", Command: "/nonexistent/oar-probe"}

func TestEveryDeclaredRefusalIsWhatSessionRejectsWith(t *testing.T) {
	runtime := Runtime()
	var keys []string
	for option, reason := range runtime.RefusedSessionOptions {
		keys = append(keys, string(option))
		_, err := runtime.Session(context.Background(), nowhere, givenOption(option))
		var unsupported *oar.UnsupportedOptionError
		if !errors.As(err, &unsupported) || unsupported.Option != string(option) {
			t.Fatalf("%s: %#v", option, err)
		}
		want := reason
		if option == oar.OptionDisallowedTools {
			want += `: ["native_tool"]`
		}
		if unsupported.Message != want {
			t.Fatalf("%s: %q, want %q", option, unsupported.Message, want)
		}
	}
	slices.Sort(keys)
	jsonEqual(t, keys, declaredRefusals)
}

func TestEmptyListsAreNoOptionGivenEvenOnRefusedRuntimes(t *testing.T) {
	refused := Runtime().RefusedSessionOptions
	for _, options := range []oar.SessionOptions{
		{Cwd: "/tmp", MCPServers: []oar.McpServer{}},
		{Cwd: "/tmp", DisallowedTools: []string{}},
		{Cwd: "/tmp", AdditionalDirectories: []string{}},
	} {
		if err := shared.RefuseSessionOptions(refused, options); err != nil {
			t.Fatal(err)
		}
	}
}

var declaredRefusals = []string{"disallowedTools", "name", "outputSchema", "serviceTier"}

func TestUnsupportedToolDenialRefusesBeforeResumeLookupAndPromptPreparation(t *testing.T) {
	runner := useRunner(t)
	_, err := Session(context.Background(), nowhere, oar.SessionOptions{Cwd: "/nonexistent", Resume: "old", DisallowedTools: []string{"mcp__server__tool"}, SystemPrompt: oar.String("replace")})
	var unsupported *oar.UnsupportedOptionError
	if !errors.As(err, &unsupported) || unsupported.Option != "disallowedTools" {
		t.Fatalf("%#v", err)
	}
	if len(runner.recorded()) != 0 {
		t.Fatal("queried")
	}
}
