package observe_test

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// tests/stopped-turn.test.ts

const stRoot = "root"

var stFailed = oar.Failed(oar.FailureRuntimeExited, "runtime exited")

func stOutcomeFor(stop string) oar.TurnOutcome {
	if stop == "accepted" || stop == "dispose" {
		return oar.AbortedOutcome()
	}
	return stFailed
}

func stRespondToStop(k *kernel.Kernel, stop string, at kernel.RecordAt) {
	if stop == "none" {
		return
	}
	kind := oar.RequestAbort
	if stop == "dispose" {
		kind = oar.RequestDispose
	}
	request := k.Request(oar.ToRuntime, oar.RequestBody{Kind: kind}, at)
	if stop == "accepted" {
		k.Respond(request.ID, oar.Accepted(), at)
	} else if stop == "rejected" {
		k.Respond(request.ID, oar.Rejected(oar.CodeRuntimeExited, "runtime exited"), at)
	}
}

func stExit(k *kernel.Kernel) oar.RawEvent {
	code := 9
	return k.Respond("", oar.ExitedBody(&code), kernel.RecordAt{})
}

func stStart(k *kernel.Kernel) int64 {
	request := k.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestPrompt, Input: "work"}, kernel.RecordAt{})
	k.Respond(request.ID, oar.Accepted(), kernel.RecordAt{})
	k.Frame(oar.FrameBody{Type: "text", Native: json.RawMessage(`{}`), Events: []oar.EventBody{oar.TextDelta{Text: "partial"}}}, kernel.RecordAt{})
	return request.Seq
}

func stFixture() (*kernel.Kernel, oar.Session) {
	k := kernel.New(stRoot)
	adapter := &fxSession{k: k}
	adapter.dispose = func() {
		stRespondToStop(k, "dispose", kernel.RecordAt{})
		stExit(k)
	}
	return k, kernel.Seal(adapter)
}

func stAssertFolds(t *testing.T, records []oar.RawEvent, afterSeq int64, expected oar.TurnOutcome) {
	t.Helper()
	idle := fxShow(fxAny(t, oar.AgentStatus{Kind: "idle", LastTurnOutcome: &expected}))
	fxEqual(t, observe.StatusOf(records, stRoot).Value, idle, "statusOf")
	fxEqual(t, observe.TurnEndAfter(records, afterSeq, stRoot, ""), fxShow(fxAny(t, expected)), "turnEndAfter")
	view := observe.ViewOf(records, "")
	fxEqual(t, view.Status, idle, "view status")
	var last *observe.ViewMessage
	for i := range view.Messages {
		if view.Messages[i].Kind == "turn" {
			last = &view.Messages[i]
		}
	}
	if last == nil {
		t.Fatal("no turn")
	}
	fxEqual(t, last.Outcome, fxShow(fxAny(t, expected)), "last turn outcome")
	fxEqual(t, view.Exited, `{"code":9}`)
}

func stAwait(t *testing.T, session oar.Session, afterSeq int64) <-chan oar.TurnOutcome {
	done := make(chan oar.TurnOutcome, 1)
	go func() {
		outcome, err := observe.AwaitTurnEnd(fxCtx(t), session, afterSeq, "")
		if err != nil {
			t.Error(err)
		}
		done <- outcome
	}()
	return done
}

func TestStoppedTurnExitAfterStopAgreesInReplayAndLive(t *testing.T) {
	for _, stop := range []string{"accepted", "rejected", "dispose", "none"} {
		t.Run(stop, func(t *testing.T) {
			k, session := stFixture()
			afterSeq := stStart(k)
			waiting := stAwait(t, session, afterSeq)
			stRespondToStop(k, stop, kernel.RecordAt{})
			// Unrelated runtime activity between the stop and exit must preserve it.
			k.Frame(oar.FrameBody{Type: "reasoning", Native: json.RawMessage(`{}`), Events: []oar.EventBody{oar.Reasoning{Content: oar.ReasoningContent{Kind: "text", Text: "still running"}}}}, kernel.RecordAt{})
			stExit(k)
			expected := stOutcomeFor(stop)
			stAssertFolds(t, k.Records(), afterSeq, expected)
			fxEqual(t, <-waiting, fxShow(fxAny(t, expected)))
			again, err := observe.AwaitTurnEnd(fxCtx(t), session, afterSeq, "")
			if err != nil {
				t.Fatal(err)
			}
			fxEqual(t, again, fxShow(fxAny(t, expected)))
		})
	}
}

// stAbortingSession answers abort the way the TS test's override does:
// abort request, its answer, then the process exit.
type stAbortingSession struct {
	oar.Session
	k    *kernel.Kernel
	stop string
}

func (s stAbortingSession) Abort(context.Context) (oar.ControlOutcome, error) {
	request := s.k.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestAbort}, kernel.RecordAt{})
	body := oar.Rejected(oar.CodeRuntimeExited, "runtime exited")
	if s.stop == "accepted" {
		body = oar.Accepted()
	}
	response := s.k.Respond(request.ID, body, kernel.RecordAt{})
	stExit(s.k)
	return kernel.ControlOutcomeOf(oar.ControlResult{Request: request, Response: response}), nil
}

func TestStoppedTurnPromptAndWaitObservesExit(t *testing.T) {
	for _, stop := range []string{"accepted", "rejected", "dispose", "none"} {
		t.Run(stop, func(t *testing.T) {
			k, session := stFixture()
			wrapped := stAbortingSession{Session: session, k: k, stop: stop}
			options := observe.PromptRunOptions{}
			if stop == "accepted" || stop == "rejected" {
				cancelled := make(chan struct{})
				close(cancelled)
				options.Cancel = cancelled
			}
			type result struct {
				run observe.PromptRun
				err error
			}
			ended := make(chan result, 1)
			go func() {
				run, err := observe.PromptAndWait(fxCtx(t), wrapped, "work", options)
				ended <- result{run, err}
			}()
			if stop == "dispose" || stop == "none" {
				// Wait for the prompt to be recorded before ending the process.
				deadline := time.Now().Add(5 * time.Second)
				for len(k.Records()) < 2 && time.Now().Before(deadline) {
					time.Sleep(time.Millisecond)
				}
			}
			if stop == "dispose" {
				if err := session.Dispose(fxCtx(t)); err != nil {
					t.Fatal(err)
				}
			}
			if stop == "none" {
				stExit(k)
			}
			got := <-ended
			if got.err != nil {
				t.Fatal(got.err)
			}
			want := "ended"
			if stop == "accepted" {
				want = "interrupted"
			}
			if got.run.Kind != want {
				t.Fatalf("kind = %s, want %s", got.run.Kind, want)
			}
			fxEqual(t, got.run.Outcome, fxShow(fxAny(t, stOutcomeFor(stop))))
		})
	}
}

func TestStoppedTurnUnansweredOrUnmatchedAbortsDoNotMarkAborted(t *testing.T) {
	k, _ := stFixture()
	afterSeq := stStart(k)
	k.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestAbort}, kernel.RecordAt{})
	k.Respond("unrelated", oar.Accepted(), kernel.RecordAt{})
	queue := k.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestQueue, Input: "later"}, kernel.RecordAt{})
	k.Respond(queue.ID, oar.Accepted(), kernel.RecordAt{})
	stExit(k)
	stAssertFolds(t, k.Records(), afterSeq, stFailed)
}

func TestStoppedTurnStopSurvivesSerializedCheckpoint(t *testing.T) {
	k, _ := stFixture()
	afterSeq := stStart(k)
	stRespondToStop(k, "accepted", kernel.RecordAt{})
	stRespondToStop(k, "rejected", kernel.RecordAt{})
	clone := func(status oar.AgentStatus) oar.AgentStatus {
		data, err := json.Marshal(status)
		if err != nil {
			t.Fatal(err)
		}
		var out oar.AgentStatus
		if err := json.Unmarshal(data, &out); err != nil {
			t.Fatal(err)
		}
		return out
	}
	status := observe.InitialStatus
	for _, record := range k.Records() {
		status = observe.ReduceStatus(clone(status), record, stRoot)
	}
	exit := stExit(k)
	fxEqual(t, observe.ReduceStatus(clone(status), exit, stRoot), `{"kind":"idle","lastTurnOutcome":{"kind":"aborted"}}`)
	stAssertFolds(t, k.Records(), afterSeq, oar.AbortedOutcome())
}

func TestStoppedTurnPreviousTurnAbortNeverStopsNext(t *testing.T) {
	for _, answer := range []string{"accepted", "pending"} {
		t.Run(answer, func(t *testing.T) {
			k, session := stFixture()
			stStart(k)
			old := k.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestAbort}, kernel.RecordAt{})
			if answer == "accepted" {
				k.Respond(old.ID, oar.Accepted(), kernel.RecordAt{})
			}
			k.Frame(oar.FrameBody{Type: "end", Native: json.RawMessage(`{}`), Events: []oar.EventBody{oar.TurnEnded{Outcome: oar.Completed()}}}, kernel.RecordAt{})
			afterSeq := stStart(k)
			if answer == "pending" {
				k.Respond(old.ID, oar.Accepted(), kernel.RecordAt{})
			}
			stExit(k)
			stAssertFolds(t, k.Records(), afterSeq, stFailed)
			outcome, err := observe.AwaitTurnEnd(fxCtx(t), session, afterSeq, "")
			if err != nil {
				t.Fatal(err)
			}
			fxEqual(t, outcome, fxShow(fxAny(t, stFailed)))
		})
	}
}

func TestStoppedTurnChildStopAndExitDoNotChangeRoot(t *testing.T) {
	for _, scope := range []kernel.RecordAt{{SessionID: "child"}, {AgentPath: []string{"child"}}} {
		k, session := stFixture()
		afterSeq := stStart(k)
		waiting := stAwait(t, session, afterSeq)
		stop := k.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestDispose}, scope)
		zero := 0
		k.Respond(stop.ID, oar.ExitedBody(&zero), scope)
		if kind := session.Status().Value.Kind; kind != "running" {
			t.Fatalf("%+v: status %s", scope, kind)
		}
		if got := observe.TurnEndAfter(k.Records(), afterSeq, stRoot, ""); got != nil {
			t.Fatalf("%+v: turn end %+v", scope, got)
		}
		if observe.ViewOf(k.Records(), "").OpenTurn == -1 {
			t.Fatalf("%+v: the root turn closed", scope)
		}
		stExit(k)
		stAssertFolds(t, k.Records(), afterSeq, stFailed)
		fxEqual(t, <-waiting, fxShow(fxAny(t, stFailed)))
	}
}

func TestStoppedTurnNativeCompletionWinsOverStopIntent(t *testing.T) {
	for _, stop := range []string{"accepted", "dispose"} {
		k, session := stFixture()
		afterSeq := stStart(k)
		waiting := stAwait(t, session, afterSeq)
		stRespondToStop(k, stop, kernel.RecordAt{})
		k.Frame(oar.FrameBody{Type: "end", Native: json.RawMessage(`{}`), Events: []oar.EventBody{oar.TurnEnded{Outcome: oar.Completed()}}}, kernel.RecordAt{})
		stExit(k)
		stAssertFolds(t, k.Records(), afterSeq, oar.Completed())
		fxEqual(t, <-waiting, `{"kind":"completed"}`, stop)
	}
}

func TestStoppedTurnHelpersRetainStopBeforeCursor(t *testing.T) {
	for _, stop := range []string{"accepted", "dispose"} {
		k, session := stFixture()
		stStart(k)
		stRespondToStop(k, stop, kernel.RecordAt{})
		records := k.Records()
		cursor := records[len(records)-1].Seq
		waiting := stAwait(t, session, cursor)
		stExit(k)
		stAssertFolds(t, k.Records(), cursor, oar.AbortedOutcome())
		fxEqual(t, <-waiting, `{"kind":"aborted"}`, stop)
	}
}
