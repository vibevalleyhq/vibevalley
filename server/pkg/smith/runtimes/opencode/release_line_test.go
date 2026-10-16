package opencode

// Ported from tests/opencode/release-line.test.ts.

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/oar"
)

var opencodeInstallation = oar.AvailableInstallation{Via: "executable", Command: "opencode"}

func versioned(version string) oar.AvailableInstallation {
	installation := opencodeInstallation
	installation.Version = version
	return installation
}

func TestNativeVersionSelectsItsOwnReleaseLine(t *testing.T) {
	for version, expected := range map[string]int{"1.18.35": 1, "opencode v2.0.26": 2, "2.0.26": 2} {
		runner := useRunner(t)
		if major, err := Major(context.Background(), versioned(version), nil); err != nil || major != expected {
			t.Fatalf("%s: %d %v", version, major, err)
		}
		if len(runner.recorded()) != 0 {
			t.Fatal("probed")
		}
	}
}

func TestAnExplicitExecutableWithNoVersionIsProbedUnknownLinesNeverFallBackToV1(t *testing.T) {
	runner := useRunner(t, ok("opencode v2.0.26\n"))
	if major, err := Major(context.Background(), opencodeInstallation, nil); err != nil || major != 2 {
		t.Fatalf("%d %v", major, err)
	}
	calls := runner.recorded()
	if len(calls) != 1 || calls[0].command != "opencode" || strings.Join(calls[0].args, " ") != "--version" ||
		calls[0].options.Timeout != 15*time.Second || calls[0].options.Dir != "" || calls[0].options.Env != nil {
		t.Fatalf("%+v", calls)
	}
	_, err := Major(context.Background(), versioned("opencode v3.0.0"), nil)
	if err == nil || !strings.Contains(err.Error(), `Unrecognized opencode release line: "opencode v3.0.0"`) {
		t.Fatal(err)
	}
}

func TestV1PreservesVerboseModelMetadataAndPerformsNoNewSessionWrites(t *testing.T) {
	runner := useRunner(t, ok("opencode/big-pickle\n{\n  \"name\": \"Big Pickle\",\n  \"variants\": {}\n}\n"))
	listed, err := ListModels(context.Background(), versioned("1.18.35"), oar.ListModelsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, listed, `{"kind": "ok", "models": [{"displayName": "Big Pickle", "id": "opencode/big-pickle"}]}`)
	cwd, _ := os.Getwd()
	calls := runner.recorded()
	if len(calls) != 1 || strings.Join(calls[0].args, " ") != "models --verbose" || calls[0].options.Dir != cwd || calls[0].options.Timeout != 30*time.Second {
		t.Fatalf("%+v", calls)
	}
}

func TestV2EmptyNativeListingIsUnsupportedNotAClaimOfNoModels(t *testing.T) {
	runner := useRunner(t, ok(""))
	listed, err := ListModels(context.Background(), versioned("opencode v2.0.26"), oar.ListModelsOptions{Timeout: 1234 * time.Millisecond})
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, listed, map[string]any{"kind": "unsupported", "reason": "opencode 2.0.26 models --standalone exits before the cold catalog finishes loading; an empty response does not establish that no models exist (https://github.com/anomalyco/opencode/issues/53724)"})
	cwd, _ := os.Getwd()
	calls := runner.recorded()
	if len(calls) != 1 || strings.Join(calls[0].args, " ") != "models --standalone" || calls[0].options.Dir != cwd || calls[0].options.Timeout != 1234*time.Millisecond {
		t.Fatalf("%+v", calls)
	}
}

// A project's opencode.json can add providers, so the catalog is read where a session would run.
func TestTheListingRunsOpencodeInTheRequestedDirectoryResolvedAgainstTheHostsCwd(t *testing.T) {
	runner := useRunner(t, ok("opencode/big-pickle\n"))
	if _, err := ListModels(context.Background(), versioned("opencode v2.0.27"), oar.ListModelsOptions{Cwd: "workspace"}); err != nil {
		t.Fatal(err)
	}
	cwd, _ := os.Getwd()
	if options := runner.recorded()[0].options; options.Dir != filepath.Join(cwd, "workspace") || options.Timeout != 30*time.Second {
		t.Fatalf("%+v", options)
	}
}

func TestAReadyV2StandaloneListingUsesNativeIDsWithoutInventingEffortMenus(t *testing.T) {
	useRunner(t, ok("opencode/big-pickle\nopencode/exo-free\n"))
	listed, err := ListModels(context.Background(), versioned("opencode v2.0.27"), oar.ListModelsOptions{})
	if err != nil {
		t.Fatal(err)
	}
	jsonEqual(t, listed, `{"kind": "ok", "models": [{"id": "opencode/big-pickle"}, {"id": "opencode/exo-free"}]}`)
}

func TestV2FailuresRetainNativeProcessDiagnostics(t *testing.T) {
	seven := 7
	useRunner(t, executable.Result{Stderr: "native catalog failure", ExitCode: &seven})
	_, err := ListModels(context.Background(), versioned("opencode v2.0.26"), oar.ListModelsOptions{})
	if err == nil || !strings.Contains(err.Error(), "native catalog failure") {
		t.Fatal(err)
	}
}

func TestV2RefusesPromptsBeforeAnyACPLaunchOrHelperQuery(t *testing.T) {
	for _, option := range []string{"systemPrompt", "appendSystemPrompt"} {
		for _, resume := range []string{"", "old-session"} {
			runner := useRunner(t)
			options := oar.SessionOptions{Cwd: "/project", Resume: resume}
			if option == "systemPrompt" {
				options.SystemPrompt = oar.String("must never disappear")
			} else {
				options.AppendSystemPrompt = oar.String("must never disappear")
			}
			_, err := Session(context.Background(), versioned("opencode v2.0.26"), options)
			var unsupported *oar.UnsupportedOptionError
			if !errors.As(err, &unsupported) || unsupported.Option != option {
				t.Fatalf("%s resume=%q: %v", option, resume, err)
			}
			if len(runner.recorded()) != 0 {
				t.Fatal("queried")
			}
		}
	}
}

func TestReleaseLineDiscoveryUsesTheSessionCwdAndEnvironmentIncludingRemovals(t *testing.T) {
	t.Setenv("OAR_VERSION_REMOVE", "inherited")
	t.Setenv("OAR_VERSION_OVERRIDE", "inherited")
	runner := useRunner(t, ok("opencode v2.0.26"))
	major, err := Major(context.Background(), opencodeInstallation, &oar.SessionOptions{Cwd: "/project", Env: map[string]*string{"OAR_VERSION_REMOVE": nil, "OAR_VERSION_OVERRIDE": oar.String("session")}})
	if err != nil || major != 2 {
		t.Fatalf("%d %v", major, err)
	}
	launched := runner.recorded()[0].options
	_, removed := envValue(launched.Env, "OAR_VERSION_REMOVE")
	overridden, _ := envValue(launched.Env, "OAR_VERSION_OVERRIDE")
	if launched.Dir != "/project" || removed || overridden != "session" {
		t.Fatalf("%+v", launched)
	}
	if os.Getenv("OAR_VERSION_REMOVE") != "inherited" {
		t.Fatal("the host environment changed")
	}
}
