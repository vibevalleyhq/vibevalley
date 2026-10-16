package claude

import (
	"reflect"
	"strings"
	"testing"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Ports tests/claude/claude-session-withdraw.test.ts.

// sentTexts is the user messages written to claude's stdin, by text.
func sentTexts(fake *fakeProcess) []string {
	texts := []string{}
	for _, message := range fake.writtenRecords() {
		content, ok := jsonx.AsRecord(message["message"])["content"].([]any)
		if message["type"] != "user" || !ok {
			continue
		}
		for _, part := range content {
			if text, ok := jsonx.AsRecord(part)["text"].(string); ok {
				texts = append(texts, text)
			}
		}
	}
	return texts
}

func openFake(t *testing.T, options oar.SessionOptions) (*fakeProcess, oar.Session) {
	t.Helper()
	fake := newFakeProcess(nil)
	useFakeSpawner(t, fake)
	if options.Cwd == "" {
		options.Cwd = "/work"
	}
	session, err := Session(testContext(t), testInstallation, options)
	if err != nil {
		t.Fatal(err)
	}
	return fake, session
}

func withdrawCode(t *testing.T, session oar.Session, inputID string) string {
	t.Helper()
	outcome, err := session.Withdraw(testContext(t), inputID)
	if err != nil {
		t.Fatal(err)
	}
	if outcome.IsAccepted() {
		return "accepted"
	}
	return string(outcome.Code)
}

func inputIDOf(outcome oar.ControlOutcome) string { return outcome.Request.Request.InputID }

// claude takes no later-turn input natively (a write while a turn runs
// steers), so the adapter holds queued input and writes the next one at each turn end.
func TestQueuedInputWithdrawnBeforeTheTurnEndsIsNeverWritten(t *testing.T) {
	ctx := testContext(t)
	fake, session := openFake(t, oar.SessionOptions{})
	first, _ := session.Prompt(ctx, "work", oar.InputOptions{})
	withdrawn, _ := session.Queue(ctx, "withdrawn", oar.InputOptions{})
	kept, _ := session.Queue(ctx, "kept", oar.InputOptions{})
	if !withdrawn.IsAccepted() || !kept.IsAccepted() {
		t.Fatalf("queues: %v %v", withdrawn.Kind, kept.Kind)
	}
	if got := withdrawCode(t, session, inputIDOf(withdrawn)); got != "accepted" {
		t.Fatalf("withdraw = %s", got)
	}
	if got := sentTexts(fake); !reflect.DeepEqual(got, []string{"work"}) {
		t.Fatalf("sent = %v", got)
	}
	fake.emitJSON(map[string]any{"type": "result", "subtype": "success", "is_error": false})
	outcome, err := observe.AwaitTurnEnd(ctx, session, first.Seq, "")
	if err != nil || outcome.Kind != "completed" {
		t.Fatalf("turn end = %v %v", outcome, err)
	}
	// The drain wrote the next held input, carrying its inputId as claude's uuid.
	eventually(t, "drain", func() bool { return len(sentTexts(fake)) == 2 })
	if got := sentTexts(fake); !reflect.DeepEqual(got, []string{"work", "kept"}) {
		t.Fatalf("sent = %v", got)
	}
	writes := fake.writes()
	if !strings.Contains(writes[len(writes)-1], inputIDOf(kept)) {
		t.Fatal("drained write lacks its inputId")
	}
	for _, id := range []string{inputIDOf(kept), inputIDOf(withdrawn), "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"} {
		if got := withdrawCode(t, session, id); got != "not_queued" {
			t.Fatalf("withdraw %s = %s", id, got)
		}
	}
	if err := session.Dispose(ctx); err != nil {
		t.Fatal(err)
	}
}

func TestQueueWhileIdleIsWrittenAtOnceAndAfterDisposeTheExitAnswersFirst(t *testing.T) {
	ctx := testContext(t)
	fake, session := openFake(t, oar.SessionOptions{})
	queued, _ := session.Queue(ctx, "now", oar.InputOptions{})
	if got := sentTexts(fake); !reflect.DeepEqual(got, []string{"now"}) {
		t.Fatalf("sent = %v", got)
	}
	if got := withdrawCode(t, session, inputIDOf(queued)); got != "not_queued" {
		t.Fatalf("withdraw = %s", got)
	}
	_, _ = session.Prompt(ctx, "work", oar.InputOptions{})
	held, _ := session.Queue(ctx, "held", oar.InputOptions{})
	if err := session.Dispose(ctx); err != nil {
		t.Fatal(err)
	}
	// The fake process exits as dispose kills it, so the stream already holds the exit.
	if got := withdrawCode(t, session, inputIDOf(held)); got != "runtime_exited" {
		t.Fatalf("withdraw = %s", got)
	}
	if got := sentTexts(fake); !reflect.DeepEqual(got, []string{"now", "work"}) {
		t.Fatalf("sent = %v", got)
	}
}
