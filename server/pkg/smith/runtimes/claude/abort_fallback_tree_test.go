//go:build wip_a

package claude

import (
	"runtime"
	"testing"
	"time"

	"vibevalley/pkg/smith/oar"
)

// Ports tests/claude/claude-abort-fallback-tree.test.ts. oar#210: a claude
// that cannot answer the interrupt is ended by the abort fallback, and the
// Bash tool command it was running, in a session of its own, must end with
// it. A real process tree: the stand-in claude ignores the interrupt and
// SIGTERM, and runs its tool out of its process group.
func TestTheAbortFallbackEndsAStuckClaudesToolThatLeftItsProcessGroup(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("POSIX process groups")
	}
	// The fallback's ten seconds, shortened; the kill it triggers is the real one.
	previous := abortFallbackTimeout
	abortFallbackTimeout = 200 * time.Millisecond
	t.Cleanup(func() { abortFallbackTimeout = previous })
	t.Setenv("OAR_KILL_GRACE_MS", "300")
	probe := withTreeProbe(t, true, true)
	ctx := testContext(t)
	session, err := Session(ctx, oar.AvailableInstallation{Via: "executable", Command: fakeAgentBinary(t, probe.dir)}, oar.SessionOptions{Cwd: probe.dir, Env: probe.env})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = session.Dispose(ctx) }()
	tree := probe.tree(t)
	started := prompt(t, session, "run the tool", "")
	if started.Response.Response.Kind != oar.ResponseAccepted {
		t.Fatalf("prompt = %v", started.Response.Response.Kind)
	}
	abort, err := session.Abort(ctx)
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, abort.Response.Response, `{"kind":"accepted"}`)
	assertJSON(t, turnEnd(t, session, started.Seq, ""), `{"kind":"aborted"}`)
	if agentGone, toolGone := gone(tree.Agent, 5*time.Second), gone(tree.Grandchild, time.Second); !agentGone || !toolGone {
		t.Fatalf("claude gone %v, its tool gone %v", agentGone, toolGone)
	}
}
