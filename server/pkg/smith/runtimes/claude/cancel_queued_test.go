//go:build wip_a

package claude

import (
	"fmt"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Ports tests/claude/claude-cancel-queued.test.ts.

const cancelInputID = "6f1c2d3e-0002-4a5b-8c7d-000000000002"

func lifecycleFrame(state, id string) map[string]any {
	return map[string]any{"type": "command_lifecycle", "command_uuid": id, "state": state}
}

func lastWrite(fake *fakeProcess) jsonx.Record {
	writes := fake.writes()
	if len(writes) == 0 {
		return nil
	}
	return jsonx.ParseRecord([]byte(writes[len(writes)-1]))
}

// cancelSetup opens a session on a claude that answers every control_request
// with success, reports the cancel-queued capability (or not) and ends its startup turn.
func cancelSetup(t *testing.T, capability bool) (*fakeProcess, oar.Session, *lineSync) {
	t.Helper()
	fake := newFakeProcess(func(text string, process *fakeProcess) {
		request := jsonx.ParseRecord([]byte(text))
		if request["type"] == "control_request" {
			process.emitJSON(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": request["request_id"]}})
		}
	})
	session, sync := openScripted(t, fake, oar.SessionOptions{})
	capabilities := []any{}
	if capability {
		capabilities = []any{"interrupt_cancel_queued_v1"}
	}
	sync.emit(t, map[string]any{"type": "system", "subtype": "init", "capabilities": capabilities}, map[string]any{"type": "result", "is_error": false})
	return fake, session, sync
}

func abortOutcome(t *testing.T, session oar.Session) oar.ControlOutcome {
	t.Helper()
	outcome, err := session.Abort(testContext(t))
	if err != nil {
		t.Fatal(err)
	}
	return outcome
}

func TestAbortCancelsAPendingPromptWithoutInventingATurnEnd(t *testing.T) {
	for _, stage := range []string{"before-queued", "queued", "notification", "after-notification"} {
		t.Run(stage, func(t *testing.T) {
			fake, session, sync := cancelSetup(t, true)
			started := prompt(t, session, "hello", cancelInputID)
			waiting := startAwaitTurnEnd(t, session, started.Seq, cancelInputID)
			if stage != "before-queued" {
				sync.emit(t, lifecycleFrame("queued", cancelInputID))
			}
			if stage == "notification" || stage == "after-notification" {
				sync.emit(t, map[string]any{"type": "system", "subtype": "init"})
			}
			if stage == "after-notification" {
				sync.emit(t, map[string]any{"type": "result", "is_error": false})
			}
			endCount := len(eventsOfKind(recordEvents(session.Records()), "turn_ended"))
			if outcome := abortOutcome(t, session); !outcome.IsAccepted() {
				t.Fatalf("abort = %v %s", outcome.Code, outcome.Reason)
			}
			matchJSON(t, lastWrite(fake), `{"request":{"subtype":"interrupt","cancel_queued":true}}`)
			sync.emit(t, lifecycleFrame("cancelled", cancelInputID))
			assertJSON(t, waiting.wait(t), `{"kind":"aborted"}`)
			assertJSON(t, observe.TurnEndAfter(session.Records(), started.Seq, session.ID(), cancelInputID), `{"kind":"aborted"}`)
			events := recordEvents(session.Records())
			if got := len(eventsOfKind(events, "turn_ended")); got != endCount {
				t.Fatalf("turn ends %d, want %d", got, endCount)
			}
			assertJSON(t, eventsOfKind(events, "input_dropped"), `[{"kind":"input_dropped","inputId":"`+cancelInputID+`","reason":"turn_interrupted"}]`)
			want := "idle"
			if stage == "notification" {
				want = "running"
			}
			if got := session.Status().Value.Kind; got != want {
				t.Fatalf("status = %s, want %s", got, want)
			}
			view := observe.ViewOf(session.Records(), "")
			if len(view.PendingInputs) != 0 {
				t.Fatalf("pending inputs = %d", len(view.PendingInputs))
			}
			input, index := viewInput(view, cancelInputID)
			if index < 0 {
				t.Fatal("no input message")
			}
			matchJSON(t, input, `{"input":{"state":"dropped","reason":"turn_interrupted"}}`)
			for _, turn := range viewTurns(view) {
				if turn.OpenedBy == started.RequestID {
					t.Fatal("a turn opened by the cancelled prompt")
				}
			}
			if stage == "notification" {
				sync.emit(t, map[string]any{"type": "result", "is_error": false})
			}
			if next := prompt(t, session, "next", ""); !next.IsAccepted() {
				t.Fatalf("next = %v %s", next.Code, next.Reason)
			}
		})
	}
}

func TestANativeCancellationSweepEndsScopedWaitsAndAwaitIdleWithoutAnAbort(t *testing.T) {
	_, session, sync := cancelSetup(t, true)
	started := prompt(t, session, "hello", cancelInputID)
	sync.emit(t, lifecycleFrame("queued", cancelInputID))
	idle := startAwaitIdle(t, session)
	sync.emit(t, lifecycleFrame("cancelled", cancelInputID))
	assertJSON(t, idle.wait(t), `{"kind":"aborted"}`)
	assertJSON(t, turnEnd(t, session, started.Seq, cancelInputID), `{"kind":"aborted"}`)
	if session.Status().Value.Kind != "idle" {
		t.Fatal("not idle")
	}
	for _, record := range session.Records() {
		if record.Kind == oar.KindRequest && record.Request.Kind == oar.RequestAbort {
			t.Fatal("an abort request was recorded")
		}
	}
}

func TestAbortOfAStartedPromptRemainsAnOrdinaryInterrupt(t *testing.T) {
	for _, capability := range []bool{false, true} {
		t.Run(fmt.Sprint(capability), func(t *testing.T) {
			fake, session, sync := cancelSetup(t, capability)
			prompt(t, session, "hello", cancelInputID)
			sync.emit(t, lifecycleFrame("queued", cancelInputID), lifecycleFrame("started", cancelInputID))
			abortOutcome(t, session)
			assertJSON(t, lastWrite(fake)["request"], `{"subtype":"interrupt"}`)
			sync.emit(t, map[string]any{"type": "result", "is_error": false}, lifecycleFrame("cancelled", cancelInputID))
			assertJSON(t, eventsOfKind(recordEvents(session.Records()), "input_dropped"), `[]`)
		})
	}
}

func TestWithoutTheCapabilityAnInterruptLeavesTheQueuedPromptForItsOwnResult(t *testing.T) {
	fake, session, sync := cancelSetup(t, false)
	started := prompt(t, session, "hello", cancelInputID)
	sync.emit(t, lifecycleFrame("queued", cancelInputID), map[string]any{"type": "system", "subtype": "init"})
	abortOutcome(t, session)
	assertJSON(t, lastWrite(fake)["request"], `{"subtype":"interrupt"}`)
	sync.emit(t, map[string]any{"type": "result", "is_error": false})
	if end := observe.TurnEndAfter(session.Records(), started.Seq, session.ID(), cancelInputID); end != nil {
		t.Fatalf("turn end = %v", *end)
	}
	sync.emit(t, lifecycleFrame("started", cancelInputID), map[string]any{"type": "result", "is_error": false})
	assertJSON(t, turnEnd(t, session, started.Seq, cancelInputID), `{"kind":"completed"}`)
}

func TestPromptAndWaitCancelDuringANotificationResolvesOnItsOwnNativeCancellation(t *testing.T) {
	fake, session, sync := cancelSetup(t, true)
	cancel := make(chan struct{})
	run := startPromptAndWait(t, session, "hello", observe.PromptRunOptions{InputID: cancelInputID, Cancel: cancel})
	eventually(t, "the prompt written", func() bool { return len(fake.writes()) == 1 })
	sync.emit(t, lifecycleFrame("queued", cancelInputID), map[string]any{"type": "system", "subtype": "init"},
		map[string]any{"type": "assistant", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "notification"}}}})
	close(cancel)
	eventually(t, "the interrupt written", func() bool { return len(fake.writes()) == 2 })
	sync.emit(t, lifecycleFrame("cancelled", cancelInputID))
	result := run.wait(t)
	if result.Kind != "interrupted" || result.By != "signal" || result.Text != "" || result.Outcome.Kind != "aborted" {
		t.Fatalf("run = %+v", result)
	}
	sync.emit(t, map[string]any{"type": "result", "is_error": false})
	if session.Status().Value.Kind != "idle" {
		t.Fatal("not idle")
	}
}

func TestAwaitIdleKeepsWaitingWhenACancelledInputLeavesANotificationTurnRunning(t *testing.T) {
	_, session, sync := cancelSetup(t, true)
	prompt(t, session, "hello", cancelInputID)
	sync.emit(t, lifecycleFrame("queued", cancelInputID), map[string]any{"type": "system", "subtype": "init"})
	idle := startAwaitIdle(t, session)
	abortOutcome(t, session)
	sync.emit(t, lifecycleFrame("cancelled", cancelInputID))
	time.Sleep(20 * time.Millisecond)
	if idle.settled() {
		t.Fatal("awaitIdle settled while the notification turn runs")
	}
	sync.emit(t, map[string]any{"type": "result", "is_error": false})
	assertJSON(t, idle.wait(t), `{"kind":"aborted"}`)
}

func TestCancelledBeforeTheInterruptReceiptNeedsNoResultAndDisarmsForcedTermination(t *testing.T) {
	// TS advances fake timers past the ten-second fallback; Go shortens the fallback instead.
	previous := abortFallbackTimeout
	abortFallbackTimeout = 100 * time.Millisecond
	t.Cleanup(func() { abortFallbackTimeout = previous })
	fake := newFakeProcess(func(text string, process *fakeProcess) {
		message := jsonx.ParseRecord([]byte(text))
		if message["type"] != "control_request" {
			return
		}
		process.emitJSON(lifecycleFrame("cancelled", cancelInputID))
		process.emitJSON(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": message["request_id"],
			"response": map[string]any{"still_queued": []any{}, "cancelled": []any{cancelInputID}}}})
	})
	session, sync := openScripted(t, fake, oar.SessionOptions{})
	sync.emit(t, map[string]any{"type": "system", "subtype": "init", "capabilities": []any{"interrupt_cancel_queued_v1"}}, map[string]any{"type": "result", "is_error": false})
	started := prompt(t, session, "hello", cancelInputID)
	sync.emit(t, lifecycleFrame("queued", cancelInputID))
	if outcome := abortOutcome(t, session); !outcome.IsAccepted() {
		t.Fatalf("abort = %v", outcome.Code)
	}
	assertJSON(t, turnEnd(t, session, started.Seq, cancelInputID), `{"kind":"aborted"}`)
	time.Sleep(300 * time.Millisecond)
	if fake.killed() {
		t.Fatal("the fallback killed claude")
	}
	if session.Status().Value.Kind != "idle" {
		t.Fatal("not idle")
	}
}
