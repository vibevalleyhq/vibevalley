package acp_test

// Ported from tests/acp/acp-session-withdraw.test.ts.

import (
	"context"
	"net/url"
	"os"
	"path/filepath"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
)

// withdraw is tests/fixtures/withdraw.ts: `accepted`, or the rejection code.
func withdraw(t *testing.T, session oar.Session, inputID string) string {
	t.Helper()
	if !session.CanWithdraw() {
		t.Fatal("this session has no withdraw")
	}
	outcome, err := session.Withdraw(context.Background(), inputID)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.Request.Request.Kind != oar.RequestWithdraw {
		t.Fatal("not a withdraw request")
	}
	if outcome.IsAccepted() {
		return "accepted"
	}
	return string(outcome.Code)
}

func inputIDOf(outcome oar.ControlOutcome) string { return outcome.Request.Request.InputID }

func TestWithdrawnInputIsNeverPromptedAndTheNextHeldInputStillDrains(t *testing.T) {
	session := start(t, nil)
	first := prompt(t, session, "hold", oar.InputOptions{})
	withdrawn := queue(t, session, "withdrawn", oar.InputOptions{})
	kept := queue(t, session, "kept", oar.InputOptions{})
	equalStrings(t, []string{string(withdrawn.Kind), string(kept.Kind)}, []string{"accepted", "accepted"})
	if got := withdraw(t, session, inputIDOf(withdrawn)); got != "accepted" {
		t.Fatal(got)
	}
	abort(t, session)
	jsonEqual(t, awaitTurnEnd(t, session, first.Seq), map[string]any{"kind": "aborted"})
	// The drained input runs as a turn of its own, ending after the aborted one.
	jsonEqual(t, awaitTurnEnd(t, session, lastSeq(session)), map[string]any{"kind": "completed"})
	equalStrings(t, said(session), []string{"echo:kept"})
	for _, inputID := range []string{inputIDOf(kept), inputIDOf(withdrawn), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"} {
		if got := withdraw(t, session, inputID); got != "not_queued" {
			t.Fatalf("withdraw %s: %s", inputID, got)
		}
	}
}

func TestQueueWhileIdleStartsAtOnceSoThereIsNothingToWithdraw(t *testing.T) {
	session := start(t, nil)
	idle := queue(t, session, "idle", oar.InputOptions{})
	if got := withdraw(t, session, inputIDOf(idle)); got != "not_queued" {
		t.Fatal(got)
	}
	jsonEqual(t, awaitTurnEnd(t, session, idle.Seq), map[string]any{"kind": "completed"})
	equalStrings(t, said(session), []string{"echo:idle"})
}

// TS starts dispose() and withdraws in the same tick; Go's Dispose blocks,
// so the withdraw follows once the dispose request is recorded, against an
// agent that outlives the SIGTERM for the kill grace (500 ms), so the dispose
// is still under way.
func TestWithdrawWhileDisposeIsUnderWayIsRefusedDisposed(t *testing.T) {
	keepAlive := filepath.Join(t.TempDir(), "keep-alive.mjs")
	if err := os.WriteFile(keepAlive, []byte("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OAR_KILL_GRACE_MS", "500")
	session := start(t, func(profile *acp.Profile) {
		profile.Args = acp.StaticArgs("--import", (&url.URL{Scheme: "file", Path: keepAlive}).String(), fixture, "session")
	})
	prompt(t, session, "hold", oar.InputOptions{})
	held := queue(t, session, "held", oar.InputOptions{})
	from := len(session.Records())
	disposing := make(chan error, 1)
	go func() { disposing <- session.Dispose(context.Background()) }()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	waitDispose(ctx, t, session, from)
	if got := withdraw(t, session, inputIDOf(held)); got != "disposed" {
		t.Fatal(got)
	}
	if err := <-disposing; err != nil {
		t.Fatal(err)
	}
	equalStrings(t, said(session), []string{})
}

func waitDispose(ctx context.Context, t *testing.T, session oar.Session, from int) {
	t.Helper()
	for {
		for _, record := range session.Records()[from:] {
			if record.Kind == oar.KindRequest && record.Request.Kind == oar.RequestDispose {
				return
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal("no dispose request")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

var _ = kernel.ControlOutcomeOf
