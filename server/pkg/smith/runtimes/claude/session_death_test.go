//go:build wip_b

package claude

import (
	"fmt"
	"testing"
	"time"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Ports tests/claude/claude-session-death.test.ts.

var deathInstallation = oar.AvailableInstallation{Via: "executable", Command: "claude", Version: "2.1.268"}

func b_describe(record oar.RawEvent) string {
	switch record.Kind {
	case oar.KindFrame:
		return "event " + record.Frame.Type
	case oar.KindRequest:
		return "request " + string(record.Request.Kind)
	case oar.KindResponse:
		if record.Response.Kind == oar.ResponseExited {
			code := "null"
			if record.Response.ExitCode != nil {
				code = fmt.Sprint(*record.Response.ExitCode)
			}
			return "response exited code=" + code + " for=" + jsonText(record.RequestID)
		}
		return "response " + string(record.Response.Kind)
	}
	return "?"
}

// Pinned live on claude 2.1.268: SIGKILL mid-turn yields an exited response
// pointing at no request, the turn ends as runtime_exited for observers, and
// every later control is rejected: a dead stdin must never take input over.
func b_killedMidTurn(t *testing.T) (oar.Session, int64) {
	t.Helper()
	fake := newFakeProcess(nil)
	useFakeSpawner(t, fake)
	session, err := Session(testContext(t), deathInstallation, oar.SessionOptions{Cwd: "/work"})
	if err != nil {
		t.Fatal(err)
	}
	started, _ := session.Prompt(testContext(t), "run something long", oar.InputOptions{})
	if !started.IsAccepted() {
		t.Fatalf("prompt = %v", started.Kind)
	}
	fake.end(nil)
	<-fake.Exited()
	return session, started.Request.Seq
}

func TestUnrequestedExitIsAnExitPointingAtNoRequestAndEndsTheTurn(t *testing.T) {
	session, promptSeq := b_killedMidTurn(t)
	records := session.Records()
	if got := b_describe(records[len(records)-1]); got != `response exited code=null for=""` {
		t.Fatalf("last = %s", got)
	}
	outcome, err := observe.AwaitTurnEnd(testContext(t), session, promptSeq, "")
	if err != nil {
		t.Fatal(err)
	}
	assertJSON(t, outcome, `{"kind":"failed","reason":"runtime exited","failure":"runtime_exited"}`)
	_ = session.Dispose(testContext(t))
}

func TestAfterAnUnrequestedExitEveryControlIsRejectedAndALaterDisposeIsAnswered(t *testing.T) {
	ctx := testContext(t)
	session, _ := b_killedMidTurn(t)
	prompt, _ := session.Prompt(ctx, "again", oar.InputOptions{})
	steer, _ := session.Steer(ctx, "x", oar.InputOptions{})
	queue, _ := session.Queue(ctx, "y", oar.InputOptions{})
	abort, _ := session.Abort(ctx)
	for _, result := range []oar.ControlOutcome{prompt, steer, queue, abort} {
		assertJSON(t, result.Response.Response, `{"kind":"rejected","code":"runtime_exited","reason":"runtime exited"}`)
	}
	_ = session.Dispose(ctx)
	records := session.Records()
	if got := []string{b_describe(records[len(records)-2]), b_describe(records[len(records)-1])}; got[0] != "request dispose" || got[1] != "response accepted" {
		t.Fatalf("last = %v", got)
	}
}

func TestExitSettlesEveryUnansweredInterruptOnceALateControlResponseIsOnlyAFrame(t *testing.T) {
	ctx := testContext(t)
	fake := newFakeProcess(nil)
	useFakeSpawner(t, fake)
	session, err := Session(ctx, deathInstallation, oar.SessionOptions{Cwd: "/work"})
	if err != nil {
		t.Fatal(err)
	}
	prompt, _ := session.Prompt(ctx, "hold", oar.InputOptions{})
	aborts := make(chan oar.ControlOutcome, 2)
	for range 2 {
		go func() {
			outcome, _ := session.Abort(ctx)
			aborts <- outcome
		}()
	}
	abortIDs := func() []string {
		var ids []string
		for _, record := range session.Records() {
			if record.Kind == oar.KindRequest && record.Request.Kind == oar.RequestAbort {
				ids = append(ids, record.ID)
			}
		}
		return ids
	}
	eventually(t, "two aborts", func() bool { return len(abortIDs()) == 2 })
	ids := abortIDs()
	fake.end(intPtr(9))
	<-fake.Exited()
	responsesTo := func(id string) []oar.RawEvent {
		var out []oar.RawEvent
		for _, record := range session.Records() {
			if record.Kind == oar.KindResponse && record.RequestID == id {
				out = append(out, record)
			}
		}
		return out
	}
	for _, id := range ids {
		if responses := responsesTo(id); len(responses) != 1 || responses[0].Response.Code != oar.CodeRuntimeExited {
			t.Fatalf("responses to %s = %v", id, responses)
		}
		// Node's exit event can precede the last data event on stdout.
		late := map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": id}}
		b_lateLine(fake, jsonText(late))
		if len(responsesTo(id)) != 1 {
			t.Fatal("a late reply answered the request again")
		}
		records := session.Records()
		last := records[len(records)-1]
		if last.Kind != oar.KindFrame || last.Frame.Type != "control_response" || len(last.Frame.Events) != 0 || !b_sameJSON(jsonx.ParseRecord(last.Frame.Native), late) {
			t.Fatalf("last = %+v", last)
		}
	}
	for range 2 {
		assertJSON(t, (<-aborts).Response.Response, `{"kind":"rejected","code":"runtime_exited","reason":"runtime exited"}`)
	}
	outcome, err := observe.AwaitTurnEnd(ctx, session, prompt.Request.Seq, "")
	if err != nil || outcome.Failure != oar.FailureRuntimeExited {
		t.Fatalf("outcome = %v %v", outcome, err)
	}
	_ = session.Dispose(ctx)
}

func TestStuckAbortedTurnIsKilledEvenWhenTheInterruptWasAcknowledged(t *testing.T) {
	for _, acknowledge := range []bool{false, true} {
		t.Run(fmt.Sprint(acknowledge), func(t *testing.T) {
			const deadline = 600 * time.Millisecond
			b_shorten(t, &abortFallbackTimeout, deadline)
			ctx := testContext(t)
			fake := newFakeProcess(func(text string, child *fakeProcess) {
				message := b_requestOf(text)
				if acknowledge && message["type"] == "control_request" {
					child.emitJSON(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": message["request_id"]}})
				}
			})
			useFakeSpawner(t, fake)
			session, err := Session(ctx, deathInstallation, oar.SessionOptions{Cwd: "/work"})
			if err != nil {
				t.Fatal(err)
			}
			prompt, _ := session.Prompt(ctx, "hold", oar.InputOptions{})
			liveEnd := make(chan oar.TurnOutcome, 1)
			go func() {
				outcome, _ := observe.AwaitTurnEnd(ctx, session, prompt.Request.Seq, "")
				liveEnd <- outcome
			}()
			started := time.Now()
			abort := make(chan oar.ControlOutcome, 1)
			go func() {
				outcome, _ := session.Abort(ctx)
				abort <- outcome
			}()
			time.Sleep(deadline / 2)
			repeated := make(chan oar.ControlOutcome, 1)
			go func() {
				outcome, _ := session.Abort(ctx)
				repeated <- outcome
			}()
			// The second abort cannot postpone the first one's deadline.
			time.Sleep(deadline - 100*time.Millisecond - time.Since(started))
			if fake.killed() {
				t.Fatal("killed before the deadline")
			}
			eventually(t, "the fallback kill", fake.killed)
			if elapsed := time.Since(started); elapsed > deadline+deadline/2 {
				t.Fatalf("killed after %v, the repeated abort moved the deadline", elapsed)
			}
			result := <-abort
			<-repeated
			if result.Response.Response.Kind != oar.ResponseAccepted {
				t.Fatalf("abort = %+v", result.Response.Response)
			}
			count, exited := 0, false
			for _, record := range session.Records() {
				if record.Kind == oar.KindResponse && record.RequestID == result.Request.ID {
					count++
				}
				if record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseExited {
					exited = true
				}
			}
			if count != 1 {
				t.Fatalf("%d responses to the abort", count)
			}
			eventually(t, "exit recorded", func() bool {
				for _, record := range session.Records() {
					if record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseExited {
						return true
					}
				}
				return exited
			})
			assertJSON(t, <-liveEnd, `{"kind":"aborted"}`)
			outcome, _ := observe.AwaitTurnEnd(ctx, session, prompt.Request.Seq, "")
			assertJSON(t, outcome, `{"kind":"aborted"}`)
			_ = session.Dispose(ctx)
		})
	}
}

func TestCompletedTurnCancelsTheAbortDeadlineBeforeAnotherTurnStarts(t *testing.T) {
	b_shorten(t, &abortFallbackTimeout, 200*time.Millisecond)
	ctx := testContext(t)
	fake := newFakeProcess(nil)
	useFakeSpawner(t, fake)
	session, err := Session(ctx, deathInstallation, oar.SessionOptions{Cwd: "/work"})
	if err != nil {
		t.Fatal(err)
	}
	_, _ = session.Prompt(ctx, "first", oar.InputOptions{})
	abort := make(chan struct{})
	go func() {
		_, _ = session.Abort(ctx)
		close(abort)
	}()
	eventually(t, "the interrupt", func() bool { return len(fake.writes()) == 2 })
	fake.emitJSON(map[string]any{"type": "control_response", "response": map[string]any{"subtype": "success", "request_id": "interrupt-1"}})
	<-abort
	fake.emitJSON(map[string]any{"type": "result", "subtype": "success", "is_error": false})
	eventually(t, "idle", func() bool { return session.Status().Value.Kind == "idle" })
	next, _ := session.Prompt(ctx, "next", oar.InputOptions{})
	if !next.IsAccepted() {
		t.Fatalf("next = %v", next.Code)
	}
	time.Sleep(400 * time.Millisecond)
	if fake.killed() {
		t.Fatal("a finished turn's abort deadline killed claude")
	}
	_ = session.Dispose(ctx)
}

// A later refused attempt must not cancel an earlier accepted interrupt's fallback.
func TestRefusedInterruptCancelsOnlyItsOwnDeadlineAttempt(t *testing.T) {
	for _, earlierAccepted := range []bool{false, true} {
		t.Run(fmt.Sprint(earlierAccepted), func(t *testing.T) {
			b_shorten(t, &abortFallbackTimeout, 200*time.Millisecond)
			ctx := testContext(t)
			fake := newFakeProcess(nil)
			useFakeSpawner(t, fake)
			session, err := Session(ctx, deathInstallation, oar.SessionOptions{Cwd: "/work"})
			if err != nil {
				t.Fatal(err)
			}
			_, _ = session.Prompt(ctx, "hold", oar.InputOptions{})
			abortAnswered := func(id string, subtype string) {
				done := make(chan struct{})
				go func() {
					_, _ = session.Abort(ctx)
					close(done)
				}()
				eventually(t, id, func() bool {
					for _, text := range fake.writes() {
						if b_requestOf(text)["request_id"] == id {
							return true
						}
					}
					return false
				})
				fake.emitJSON(map[string]any{"type": "control_response", "response": map[string]any{"subtype": subtype, "request_id": id}})
				<-done
			}
			first := "error"
			if earlierAccepted {
				first = "success"
			}
			abortAnswered("interrupt-1", first)
			abortAnswered("interrupt-2", "error")
			time.Sleep(400 * time.Millisecond)
			if fake.killed() != earlierAccepted {
				t.Fatalf("killed = %v", fake.killed())
			}
			_ = session.Dispose(ctx)
		})
	}
}
