//go:build wip_a

package claude

import (
	"errors"
	"regexp"
	"testing"

	"vibevalley/pkg/smith/oar"
)

// Ports tests/claude/claude-launch-args.test.ts. #336: --continue made claude
// exit next to OAR's --session-id, and after --fork-session Session.ID kept
// the old id. Such flags are refused up front.
func TestManagedLaunchArgsAreRefused(t *testing.T) {
	for _, flag := range []string{"--continue", "-c", "--resume", "-r", "--session-id", "--fork-session", "--permission-mode=plan", "--permission-mode", "-p", "--output-format", "--json-schema"} {
		var unsupported *oar.UnsupportedOptionError
		if err := refuseManagedLaunchArgs([]string{flag, "value"}); !errors.As(err, &unsupported) {
			t.Fatalf("launchArgs %s: %v", flag, err)
		}
	}
}

func TestOtherLaunchArgsPassAndTheRefusalNamesTheFlag(t *testing.T) {
	if err := refuseManagedLaunchArgs([]string{"--tools", "Read,Grep", "--add-dir", "/x", "--max-turns", "2"}); err != nil {
		t.Fatal(err)
	}
	if err := refuseManagedLaunchArgs(nil); err != nil {
		t.Fatal(err)
	}
	err := refuseManagedLaunchArgs([]string{"--resume=abc"})
	if err == nil || !regexp.MustCompile(`claude launchArgs cannot include --resume: use SessionOptions\.resume`).MatchString(err.Error()) {
		t.Fatalf("refusal = %v", err)
	}
}
