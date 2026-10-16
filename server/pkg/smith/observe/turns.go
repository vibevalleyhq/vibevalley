package observe

import (
	"context"
	"crypto/rand"
	"fmt"
	"strings"
	"sync"
	"time"

	"vibevalley/pkg/smith/oar"
)

// Turn helpers (observe/turns.ts). A turn is a span on the stream: a prompt
// request is its fallback start, native input_queued / turn_active with an
// inputId can establish its actual start; it ends at the runtime's own
// turn_ended (or an observed process exit). Scope: the root session's root agent.

// TurnEndAfter is the root-agent turn end after afterSeq, if the records already hold one.
func TurnEndAfter(records []oar.RawEvent, afterSeq int64, sessionID, inputID string) *oar.TurnOutcome {
	read := turnEndReader(afterSeq, sessionID, inputID, nil, false)
	for _, record := range records {
		if outcome := read(record); outcome != nil {
			return outcome
		}
	}
	return nil
}

func turnEndReader(afterSeq int64, sessionID, inputID string, onText func(string), onlyWhenIdle bool) func(oar.RawEvent) *oar.TurnOutcome {
	status := InitialStatus
	waitingForInput := false
	return func(record oar.RawEvent) *oar.TurnOutcome {
		if len(record.AgentPath) > 0 || (sessionID != "" && record.SessionID != sessionID) {
			return nil
		}
		previous := status
		status = ReduceStatus(previous, record, sessionID)
		if record.Kind == oar.KindFrame {
			for _, event := range record.Frame.Events {
				switch e := event.(type) {
				case oar.InputQueued:
					if inputID != "" && e.InputID == inputID {
						waitingForInput = true
					}
				case oar.TurnActive:
					if inputID != "" && e.InputID == inputID {
						waitingForInput = false
					}
				case oar.InputDropped:
					if inputID != "" && e.InputID == inputID {
						waitingForInput = false
						if record.Seq > afterSeq && (!onlyWhenIdle || status.Kind == "idle") {
							if e.Reason == "turn_interrupted" {
								outcome := oar.AbortedOutcome()
								return &outcome
							}
							failure := e.Failure
							if failure == "" {
								failure = oar.FailureUnknown
							}
							message := e.Message
							if message == "" {
								message = "runtime refused the input"
							}
							outcome := oar.Failed(failure, message)
							return &outcome
						}
					}
				case oar.TextDelta:
					if record.Seq > afterSeq && !waitingForInput && onText != nil {
						onText(e.Text)
					}
				case oar.TurnEnded:
					if record.Seq > afterSeq && !waitingForInput && (!onlyWhenIdle || status.Kind == "idle") {
						outcome := e.Outcome
						return &outcome
					}
				}
			}
		}
		if record.Seq > afterSeq && record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseExited {
			var stop *oar.TurnStop
			if previous.IsRunning() {
				stop = previous.Stop
				if stop == nil && previous.PendingPrompt != nil {
					stop = previous.PendingPrompt.Stop
				}
			} else if previous.PendingPrompt != nil {
				stop = previous.PendingPrompt.Stop
			}
			outcome := ExitTurnOutcome(stop)
			return &outcome
		}
		return nil
	}
}

// watchTurn is one reader owning both the turn boundary and its text, replay included.
func watchTurn(ctx context.Context, session oar.Session, afterSeq int64, inputID string, onText func(string), onlyWhenIdle bool) (oar.TurnOutcome, error) {
	found := make(chan oar.TurnOutcome, 1)
	done := false
	read := turnEndReader(afterSeq, session.ID(), inputID, onText, onlyWhenIdle)
	unsubscribe := session.RawEvents(func(record oar.RawEvent) {
		if done {
			return
		}
		if outcome := read(record); outcome != nil {
			done = true
			found <- *outcome
		}
	}, &oar.Cursor{SessionID: session.ID(), AfterSeq: -1})
	defer unsubscribe()
	select {
	case outcome := <-found:
		return outcome, nil
	case <-ctx.Done():
		return oar.TurnOutcome{}, ctx.Err()
	}
}

// AwaitTurnEnd waits for the first root-agent turn end recorded after
// afterSeq, from the retained log or live. With inputID, native queue/start
// evidence excludes intervening turns.
func AwaitTurnEnd(ctx context.Context, session oar.Session, afterSeq int64, inputID string) (oar.TurnOutcome, error) {
	return watchTurn(ctx, session, afterSeq, inputID, nil, false)
}

// AwaitIdle waits until the root agent is idle: at once (nil) when the status
// already says so, otherwise with the outcome once the owned input and any
// intervening turn are no longer pending.
func AwaitIdle(ctx context.Context, session oar.Session) (*oar.TurnOutcome, error) {
	status := session.Status()
	if status.Value.Kind == "idle" && status.Value.PendingPrompt == nil {
		return nil, nil
	}
	inputID := ""
	if status.Value.PendingPrompt != nil {
		inputID = status.Value.PendingPrompt.InputID
	} else if status.Value.IsRunning() {
		inputID = status.Value.InputID
	}
	outcome, err := watchTurn(ctx, session, status.Seq, inputID, nil, true)
	if err != nil {
		return nil, err
	}
	return &outcome, nil
}

// PromptRunOptions for PromptAndWait.
type PromptRunOptions struct {
	// Input identity for native turn correlation; a fresh UUID when empty.
	InputID string
	// Abort the turn when it has not ended after this long (0: no limit).
	Timeout time.Duration
	// Abort the turn when this is cancelled (nil: never).
	Cancel <-chan struct{}
	Images []oar.InputImage
}

// PromptRun is "rejected" (Result, Code, Reason), "ended" (Result, Outcome,
// Text) or "interrupted" (By "timeout" | "signal", Result, Outcome, Text).
type PromptRun struct {
	Kind    string
	By      string
	Result  oar.ControlOutcome
	Code    oar.RejectionCode
	Reason  string
	Outcome oar.TurnOutcome
	Text    string
}

// PromptAndWait prompts, then waits for the runtime to end the turn it opened
// (observe/turns.ts promptAndWait). ctx bounds the whole wait; Timeout and
// Cancel abort the turn instead.
func PromptAndWait(ctx context.Context, session oar.Session, input string, options PromptRunOptions) (PromptRun, error) {
	inputID := options.InputID
	if inputID == "" {
		inputID = NewUUID()
	}
	result, err := session.Prompt(ctx, input, oar.InputOptions{InputID: inputID, Images: options.Images})
	if err != nil {
		return PromptRun{}, err
	}
	if !result.IsAccepted() {
		return PromptRun{Kind: "rejected", Result: result, Code: result.Code, Reason: result.Reason}, nil
	}
	var textMu sync.Mutex
	var text strings.Builder
	readText := func() string {
		textMu.Lock()
		defer textMu.Unlock()
		return text.String()
	}
	type ended struct {
		outcome oar.TurnOutcome
		err     error
	}
	endCh := make(chan ended, 1)
	waitCtx, cancelWait := context.WithCancel(ctx)
	defer cancelWait()
	go func() {
		outcome, err := watchTurn(waitCtx, session, result.Seq, inputID, func(delta string) {
			textMu.Lock()
			text.WriteString(delta)
			textMu.Unlock()
		}, false)
		endCh <- ended{outcome, err}
	}()
	var timeout <-chan time.Time
	if options.Timeout > 0 {
		timer := time.NewTimer(options.Timeout)
		defer timer.Stop()
		timeout = timer.C
	}
	by := ""
	select {
	case end := <-endCh:
		if end.err != nil {
			return PromptRun{}, end.err
		}
		return PromptRun{Kind: "ended", Result: result, Outcome: end.outcome, Text: readText()}, nil
	case <-timeout:
		by = "timeout"
	case <-options.Cancel:
		by = "signal"
	}
	abort, err := session.Abort(ctx)
	if err != nil {
		return PromptRun{}, err
	}
	end := <-endCh
	if end.err != nil {
		return PromptRun{}, end.err
	}
	if abort.IsAccepted() {
		return PromptRun{Kind: "interrupted", By: by, Result: result, Outcome: end.outcome, Text: readText()}, nil
	}
	return PromptRun{Kind: "ended", Result: result, Outcome: end.outcome, Text: readText()}, nil
}

// NewUUID is a random RFC 4122 version 4 UUID.
func NewUUID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}
