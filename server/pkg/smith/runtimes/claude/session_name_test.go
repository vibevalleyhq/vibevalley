//go:build wip_b

package claude

import (
	"slices"
	"testing"

	"vibevalley/pkg/smith/oar"
)

// Ports tests/claude/claude-session-name.test.ts.

func b_argsFor(t *testing.T, options oar.SessionOptions) []string {
	t.Helper()
	child := newFakeProcess(nil)
	spawner := useFakeSpawner(t, child)
	options.Cwd = "/work"
	if _, err := launchClaude("claude", "session", options); err != nil {
		t.Fatal(err)
	}
	child.Kill()
	return spawner.call(0).args
}

func TestNewSessionIsLaunchedWithName(t *testing.T) {
	args := b_argsFor(t, oar.SessionOptions{Name: oar.String("Raft · Otter")})
	if !containsInOrder(args, "--session-id", "session") || !containsInOrder(args, "--name", "Raft · Otter") {
		t.Fatalf("args = %v", args)
	}
}

// [env] claude 2.1.292: --name on a resume replaces the name the session has, which may be the user's.
func TestNoNameOnAResumeOrWithoutTheOption(t *testing.T) {
	for _, options := range []oar.SessionOptions{{Resume: "existing", Name: oar.String("Raft · Otter")}, {}} {
		if args := b_argsFor(t, options); slices.Contains(args, "--name") {
			t.Fatalf("args = %v", args)
		}
	}
}
