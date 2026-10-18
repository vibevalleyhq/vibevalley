package agents

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
	"vibevalley/pkg/smith/voyage"
)

// subagentHooks is what a subagent tells the crew that owns it. Never called
// with the subagent's lock held: they take the crew's.
type subagentHooks struct {
	report func(SubagentReport)
	task   func(oar.EventBody)
	// Whether one more turn may start now (the crew's running limit).
	mayRun func() bool
	closed func()
}

type subagentIdentity struct {
	id      string
	name    string
	runtime string
	log     string
	logged  *voyage.SessionRecording
}

var runningLimit = SendResult{Kind: "rejected", Code: "running_limit", Reason: "the running limit is reached; wait for a subagent to finish"}

func endStatus(outcome oar.TurnOutcome) string {
	switch outcome.Kind {
	case "completed":
		return "completed"
	case "aborted":
		return "stopped"
	}
	return "failed"
}

func rejected(outcome oar.ControlOutcome) SendResult {
	if outcome.IsAccepted() {
		return SendResult{Kind: "rejected", Code: "unknown", Reason: "accepted"}
	}
	return SendResult{Kind: "rejected", Code: string(outcome.Code), Reason: outcome.Reason}
}

// Subagent is one child session as a subagent (agents/subagent.ts): every
// turn its root agent ends becomes a report carrying the root text said in
// that turn, whether the turn began from the task, a follow-up, a queued
// input or the runtime itself. A turn the runtime never ends (its process
// exited, or Close disposed it) still gets a report, so nobody waits on it forever.
type Subagent struct {
	ID      string
	Name    string
	Runtime string
	// The child's own session, for everything the subagent surface does not cover.
	Session oar.Session

	identity  subagentIdentity
	hooks     subagentHooks
	seen      *progress
	following following

	mu      sync.Mutex
	state   SubagentState
	closing bool
	turns   int
	text    string
	lastEnd string
	waiters []chan *SubagentReport
}

func newSubagent(identity subagentIdentity, session oar.Session, hooks subagentHooks) *Subagent {
	agent := &Subagent{ID: identity.id, Name: identity.name, Runtime: identity.runtime, Session: session, identity: identity, hooks: hooks, seen: newProgress(), state: "idle", following: following{wake: make(chan struct{})}}
	reader := observe.EventsReader(agent.observe)
	// Replay must not call crew hooks while register holds the crew lock. The cursor also covers records produced
	// before this goroutine subscribes, so Prompt may safely start immediately after registration.
	go session.RawEvents(func(record oar.RawEvent) {
		reader(record)
		agent.seen.done(record.Seq)
	}, &oar.Cursor{SessionID: session.ID(), AfterSeq: -1})
	return agent
}

// settleLocked hands report (nil: closed) to every nextReport waiter.
func (a *Subagent) settleLocked(report *SubagentReport) {
	for _, waiter := range a.waiters {
		waiter <- report
	}
	a.waiters = nil
}

// endedLocked closes the open turn's report; the caller runs the returned
// hooks after releasing the lock.
func (a *Subagent) endedLocked(outcome oar.TurnOutcome, at, afterSeq int64) func() {
	a.turns++
	if a.state == "running" {
		a.state = "idle"
	}
	report := SubagentReport{ID: a.identity.id, Name: a.identity.name, Runtime: a.identity.runtime, SessionID: a.Session.ID(), Turn: a.turns, Outcome: outcome, Text: a.text, Log: a.identity.log, EndedAt: at}
	a.following.append(afterSeq, report)
	a.text = ""
	a.lastEnd = endStatus(outcome)
	copied := report
	a.settleLocked(&copied)
	ended := oar.TaskEnded{TaskID: a.identity.id, Status: a.lastEnd, OutputFile: a.identity.log}
	if report.Text != "" {
		ended.Summary = sliceUTF16(report.Text, 200)
	}
	return func() {
		a.hooks.report(report)
		a.hooks.task(ended)
	}
}

func (a *Subagent) shutLocked() func() {
	a.state = "closed"
	a.settleLocked(nil)
	return a.hooks.closed
}

func (a *Subagent) observe(event oar.Event) {
	if event.SessionID != a.Session.ID() || len(event.AgentPath) > 0 {
		return
	}
	var after []func()
	a.mu.Lock()
	switch body := event.Body.(type) {
	case oar.TurnEnded:
		after = append(after, a.endedLocked(body.Outcome, event.ReceivedAt, event.Seq))
	case oar.Exited:
		if !a.closing {
			// A runtime that died mid-turn reported no end of its own; the parent still gets one.
			if a.state == "running" {
				code := "null"
				if body.Code != nil {
					code = fmt.Sprint(*body.Code)
				}
				after = append(after, a.endedLocked(oar.Failed(oar.FailureRuntimeExited, fmt.Sprintf("the runtime exited (%s)", code)), event.ReceivedAt, event.Seq))
			}
			after = append(after, a.shutLocked())
		}
	case oar.ControlRejected:
		// A refused start leaves no turn open; the slot and the task row go back.
		if a.state == "running" && a.Session.Status().Value.Kind == "idle" {
			a.state = "idle"
			status := a.lastEnd
			if status == "" {
				status = "pending"
			}
			after = append(after, func() { a.hooks.task(oar.TaskUpdated{TaskID: a.identity.id, Status: status}) })
		}
	default:
		if hook := a.startedLocked(); hook != nil {
			after = append(after, hook)
		}
		if delta, ok := body.(oar.TextDelta); ok {
			a.text += delta.Text
		}
	}
	a.mu.Unlock()
	for _, hook := range after {
		hook()
	}
}

// startedLocked: an idle subagent whose session runs a turn is running.
func (a *Subagent) startedLocked() func() {
	if a.state != "idle" || a.closing || a.Session.Status().Value.Kind != "running" {
		return nil
	}
	a.state = "running"
	return func() { a.hooks.task(oar.TaskUpdated{TaskID: a.identity.id, Status: "running"}) }
}

// started applies startedLocked right after a control of ours began a turn.
// Go-only: TS reads the turn's first event inside the control call.
func (a *Subagent) started() {
	a.mu.Lock()
	hook := a.startedLocked()
	a.mu.Unlock()
	if hook != nil {
		hook()
	}
}

// Info is the subagent's identity and state.
func (a *Subagent) Info() SubagentInfo {
	a.mu.Lock()
	defer a.mu.Unlock()
	return SubagentInfo{ID: a.identity.id, Name: a.identity.name, Runtime: a.identity.runtime, SessionID: a.Session.ID(), State: a.state, Turns: a.turns, Log: a.identity.log}
}

func (a *Subagent) stateNow() SubagentState {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.state
}

// NextReport is the report of the next turn to end: the open one while
// running, else the next one started. nil when the subagent closes or its
// runtime exits first, or ctx ends. It does not take the report from the
// crew's unread ones; Subagents.Next does.
func (a *Subagent) NextReport(ctx context.Context) (*SubagentReport, error) {
	a.mu.Lock()
	if a.state == "closed" {
		a.mu.Unlock()
		return nil, nil
	}
	waiter := make(chan *SubagentReport, 1)
	a.waiters = append(a.waiters, waiter)
	a.mu.Unlock()
	select {
	case report := <-waiter:
		return report, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func steerOrQueue(ctx context.Context, session oar.Session, message string) (SendResult, error) {
	result, err := session.SteerOrQueue(ctx, message, oar.InputOptions{})
	if err != nil {
		return SendResult{}, err
	}
	if result.Landed == "rejected" {
		return SendResult{Kind: "rejected", Code: string(result.Code), Reason: result.Reason}, nil
	}
	return SendResult{Kind: "accepted", Landed: result.Landed}, nil
}

func (a *Subagent) followup(ctx context.Context, message string) (SendResult, error) {
	if a.Session.Status().Value.Kind != "idle" {
		return steerOrQueue(ctx, a.Session, message)
	}
	if !a.hooks.mayRun() {
		return runningLimit, nil
	}
	outcome, err := a.Session.Prompt(ctx, message, oar.InputOptions{})
	if err != nil {
		return SendResult{}, err
	}
	if outcome.IsAccepted() {
		a.started()
		return SendResult{Kind: "accepted", Landed: "prompted"}, nil
	}
	// A turn the runtime began by itself can open between the status read and the prompt.
	if outcome.Code == oar.CodeBusy {
		return steerOrQueue(ctx, a.Session, message)
	}
	return rejected(outcome), nil
}

func (a *Subagent) control(ctx context.Context, message string, mode SendMode) (SendResult, error) {
	if mode == "steer" {
		// A session that cannot steer has no steer; nothing reaches the runtime.
		if !a.Session.CanSteer() {
			return SendResult{Kind: "rejected", Code: "unsupported", Reason: a.identity.runtime + " cannot steer; send followup or queue instead"}, nil
		}
		steered, err := a.Session.Steer(ctx, message, oar.InputOptions{})
		if err != nil {
			return SendResult{}, err
		}
		if steered.IsAccepted() {
			return SendResult{Kind: "accepted", Landed: "steered"}, nil
		}
		return rejected(steered), nil
	}
	if a.Session.Status().Value.Kind == "idle" && !a.hooks.mayRun() {
		return runningLimit, nil
	}
	queued, err := a.Session.Queue(ctx, message, oar.InputOptions{})
	if err != nil {
		return SendResult{}, err
	}
	if queued.IsAccepted() {
		a.started()
		return SendResult{Kind: "accepted", Landed: "queued"}, nil
	}
	return rejected(queued), nil
}

// Send delivers a message to the child ("" mode is followup). A Go error
// means the control could not be delivered.
func (a *Subagent) Send(ctx context.Context, message string, mode SendMode) (SendResult, error) {
	a.mu.Lock()
	closed := a.state == "closed" || a.closing
	a.mu.Unlock()
	if closed {
		return SendResult{Kind: "rejected", Code: "closed", Reason: a.identity.id + " is closed"}, nil
	}
	if mode == "" || mode == "followup" {
		return a.followup(ctx, message)
	}
	return a.control(ctx, message, mode)
}

// Interrupt aborts the open turn; its report follows with the runtime's outcome.
func (a *Subagent) Interrupt(ctx context.Context) (oar.ControlOutcome, error) {
	return a.Session.Abort(ctx)
}

// Close disposes the child. A turn it was running that the runtime reports
// no end for still gets an aborted report. It returns once the subagent (and
// its log) has read every record the dispose produced.
func (a *Subagent) Close(ctx context.Context) (err error) {
	closeLog := false
	defer func() {
		if closeLog && a.identity.logged != nil {
			settle, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
			defer cancel()
			err = errors.Join(err, a.identity.logged.Close(settle))
		}
	}()
	a.mu.Lock()
	if a.closing {
		a.mu.Unlock()
		return nil
	}
	closeLog = true
	if a.state == "closed" {
		a.mu.Unlock()
		return nil
	}
	a.closing = true
	open := -1
	if a.state == "running" {
		open = a.turns
	}
	a.mu.Unlock()
	err = a.Session.Dispose(ctx)
	// Go-only: observers run on delivery goroutines; read what dispose recorded first.
	target := lastSeq(a.Session)
	settle, cancel := context.WithTimeout(context.WithoutCancel(ctx), 10*time.Second)
	defer cancel()
	a.seen.reach(settle, target)
	var after []func()
	a.mu.Lock()
	if open != -1 && a.turns == open {
		// Disposed mid-turn and the runtime reported no end for it.
		after = append(after, a.endedLocked(oar.AbortedOutcome(), time.Now().UnixMilli(), target))
	}
	after = append(after, a.shutLocked())
	a.mu.Unlock()
	for _, hook := range after {
		hook()
	}
	return err
}
