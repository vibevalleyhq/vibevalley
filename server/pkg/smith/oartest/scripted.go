// Package oartest is the public test runtime (packages/oar/src/testing): a
// runtime whose model is a script, with real Session semantics and no
// binary, login or provider.
package oartest

import (
	"context"
	"fmt"
	"math"
	"sync"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
)

// TaskSpec starts a task a script reports beside its turn.
type TaskSpec struct {
	// "shell" | "agent" | "tool" | "workflow" | "other"
	TaskType    string `json:"taskType"`
	Description string `json:"description,omitempty"`
	Background  *bool  `json:"background,omitempty"`
}

// Task is a task a script started.
type Task interface {
	ID() string
	Update(status oar.TaskStatus, description *string)
	// End with "completed" (default when empty), "failed" or "stopped".
	End(status string, summary, outputFile string)
}

// Turn is what a script sees and does during one turn. Everything it emits
// enters the stream as frames of type scripted/*. An abort or dispose ends
// the turn at once; nothing the script emits after that is recorded.
type Turn struct {
	// The input that began the turn.
	Input  string
	Images []oar.InputImage
	// The options the host opened the session with.
	Options oar.SessionOptions
	// Done when the host aborts the turn or disposes the session.
	Context context.Context

	session *scriptedSession
	state   *turnState
	calls   int
}

// Steered is the steer inputs delivered into this turn so far, oldest first.
func (t *Turn) Steered() []string {
	t.session.mu.Lock()
	defer t.session.mu.Unlock()
	return append([]string(nil), t.state.steered...)
}

func (t *Turn) liveLocked() bool {
	return t.session.active == t.state && t.state.ctx.Err() == nil
}

// Say emits assistant text.
func (t *Turn) Say(text string) {
	s := t.session
	s.mu.Lock()
	defer s.mu.Unlock()
	if !t.liveLocked() {
		return
	}
	s.totals.Output += tokensOf(text)
	s.frame("scripted/text", map[string]any{"text": text}, oar.TextDelta{Text: text})
}

// Think emits readable reasoning.
func (t *Turn) Think(text string) {
	s := t.session
	s.mu.Lock()
	defer s.mu.Unlock()
	if !t.liveLocked() {
		return
	}
	s.frame("scripted/reasoning", map[string]any{"text": text}, oar.Reasoning{Content: oar.ReasoningContent{Kind: "text", Text: text}})
}

// Tool runs a tool: tool_call_started, then run, then tool_call_ended with
// its result (ok) or the error's message (failed, and the error is
// returned). A tool that settles after the turn ended records nothing.
func (t *Turn) Tool(name, input string, run func() (any, error)) error {
	s := t.session
	s.mu.Lock()
	if !t.liveLocked() {
		s.mu.Unlock()
		return nil
	}
	t.calls++
	callID := fmt.Sprintf("call-%d", t.calls)
	s.frame("scripted/tool_start", map[string]any{"callId": callID, "name": name, "input": input}, oar.ToolCallStarted{CallID: callID, Tool: name, Input: &input})
	s.mu.Unlock()
	var result any
	var err error
	if run != nil {
		result, err = run()
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if !t.liveLocked() {
		return err
	}
	if err != nil {
		output := err.Error()
		s.frame("scripted/tool_end", map[string]any{"callId": callID, "output": output, "result": "failed"}, oar.ToolCallEnded{CallID: callID, Result: "failed", Content: []oar.ToolOutputPart{{Type: "text", Text: output}}})
		return err
	}
	s.frame("scripted/tool_end", map[string]any{"callId": callID, "output": result, "result": "ok"}, oar.ToolCallEnded{CallID: callID, Result: "ok", Content: oar.ToolContent(result)})
	return nil
}

// Task starts a task beside this turn: task_started now, updates and the end whenever the script reports them.
func (t *Turn) Task(spec TaskSpec) Task {
	s := t.session
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.startTask(spec, t.liveLocked())
}

// Options configures ScriptedRuntime.
type Options struct {
	// Registry id; default "scripted".
	ID    string
	Brand oar.RuntimeBrand
	// Reported as the session's model; default "scripted-1".
	Model string
	// One turn of behavior: returning nil ends the turn completed, an error
	// ends it failed with the message, a done context ends it aborted.
	Turn func(turn *Turn) error
}

func tokensOf(text string) int64 { return int64(math.Ceil(float64(len([]rune(text))) / 4)) }

type turnState struct {
	ctx     context.Context
	cancel  context.CancelFunc
	steered []string
}

type queued struct {
	input   string
	inputID string
	images  []oar.InputImage
}

func (q queued) HeldInputID() string { return q.inputID }

type scriptedSession struct {
	runtime  *Options
	options  oar.SessionOptions
	kernel   *kernel.Kernel
	caps     oar.SessionCapabilities
	mu       sync.Mutex
	queue    []queued
	totals   oar.TokenTotals
	active   *turnState
	disposed bool
	tasks    int
}

// Runtime is a runtime whose model is a script (testing/scripted-runtime.ts).
// Capabilities: steer, a non-durable queue whose entries can be withdrawn
// before their turn starts, no sub-agents. Installation is always bundled.
func Runtime(options Options) oar.Runtime {
	if options.ID == "" {
		options.ID = "scripted"
	}
	if options.Model == "" {
		options.Model = "scripted-1"
	}
	start := func(_ context.Context, _ oar.AvailableInstallation, sessionOptions oar.SessionOptions) (oar.Session, error) {
		if sessionOptions.Effort != "" {
			return nil, fmt.Errorf("%s lists no reasoning-effort levels; it cannot run at effort %q", options.ID, sessionOptions.Effort)
		}
		s := &scriptedSession{
			runtime: &options,
			options: sessionOptions,
			kernel:  kernel.New(sessionOptions.Resume),
			caps:    oar.SessionCapabilities{Attribution: "none", Images: true},
		}
		s.mu.Lock()
		s.frame("scripted/model", map[string]any{"model": options.Model}, oar.Model{Model: options.Model})
		s.mu.Unlock()
		return kernel.Seal(s), nil
	}
	return oar.DefineRuntime(oar.Runtime{
		ID:      options.ID,
		Brand:   options.Brand,
		Session: start,
		Installation: func(context.Context, oar.InstallationOptions) (oar.InstallationSnapshot, error) {
			return oar.Available(oar.AvailableInstallation{Via: "bundled"}), nil
		},
	})
}

func (s *scriptedSession) frame(kind string, native any, events ...oar.EventBody) {
	s.kernel.Frame(oar.FrameBody{Type: kind, Native: jsonx.Marshal(native), Events: events}, kernel.RecordAt{})
}

// run starts a turn; called under s.mu. The script starts once the lock is
// released, so the control that began the turn is answered first.
func (s *scriptedSession) run(input string, images []oar.InputImage) {
	ctx, cancel := context.WithCancel(context.Background())
	state := &turnState{ctx: ctx, cancel: cancel}
	s.active = state
	s.totals.Input += tokensOf(input)
	if images == nil {
		images = []oar.InputImage{}
	}
	turn := &Turn{Input: input, Images: images, Options: s.options, Context: ctx, session: s, state: state}
	go func() {
		// Wait for the control that began this turn to be answered.
		s.mu.Lock()
		s.mu.Unlock() //nolint:staticcheck // an empty critical section orders the turn after the answer
		outcome := s.settle(turn)
		s.mu.Lock()
		defer s.mu.Unlock()
		s.end(state, outcome)
	}()
}

func (s *scriptedSession) settle(turn *Turn) (outcome oar.TurnOutcome) {
	defer func() {
		if recovered := recover(); recovered != nil {
			if turn.Context.Err() != nil {
				outcome = oar.AbortedOutcome()
				return
			}
			outcome = oar.Failed(oar.FailureUnknown, fmt.Sprint(recovered))
		}
	}()
	err := s.runtime.Turn(turn)
	if turn.Context.Err() != nil {
		return oar.AbortedOutcome()
	}
	if err != nil {
		return oar.Failed(oar.FailureUnknown, err.Error())
	}
	return oar.Completed()
}

// end is called under s.mu.
func (s *scriptedSession) end(state *turnState, outcome oar.TurnOutcome) {
	if s.active != state {
		return // already ended (an abort or dispose ended it first)
	}
	s.active = nil
	state.cancel()
	tokens := s.totals
	total := tokens.Input + tokens.Output
	window := int64(200_000)
	percent := float64(total) / float64(window) * 100
	s.frame("scripted/end", map[string]any{"outcome": outcome},
		oar.TurnEnded{Outcome: outcome},
		oar.Usage{Usage: oar.UsageReport{Tokens: &oar.TokenTotals{Input: tokens.Input, Output: tokens.Output}, Context: &oar.ContextUsage{Tokens: &total, ContextWindow: &window, Percent: &percent}}})
	if len(s.queue) > 0 && !s.disposed {
		next := s.queue[0]
		s.queue = s.queue[1:]
		s.run(next.input, next.images)
	}
}

func (s *scriptedSession) abortActive() {
	if s.active == nil {
		return
	}
	state := s.active
	state.cancel()
	s.end(state, oar.AbortedOutcome())
}

func (s *scriptedSession) ID() string                            { return s.kernel.SessionID() }
func (s *scriptedSession) Capabilities() oar.SessionCapabilities { return s.caps }

func (s *scriptedSession) Prompt(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	body := oar.RequestBody{Kind: oar.RequestPrompt, Input: input, InputID: options.InputID, Images: options.Images, Origin: options.Origin}
	return s.kernel.Control(body, func(oar.RawEvent) (oar.ResponseBody, error) {
		if s.active != nil {
			return oar.Rejected(oar.CodeBusy, "busy"), nil
		}
		if refused := kernel.InputImagesRefusal(s.caps.Images, options.Images); refused != nil {
			return *refused, nil
		}
		s.run(input, options.Images)
		return oar.Accepted(), nil
	}, kernel.RecordAt{}), nil
}

func (s *scriptedSession) Steer(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	body := oar.RequestBody{Kind: oar.RequestSteer, Input: input, InputID: options.InputID, Images: options.Images, Origin: options.Origin}
	return s.kernel.Control(body, func(oar.RawEvent) (oar.ResponseBody, error) {
		if s.active == nil {
			return oar.Rejected(oar.CodeNoActiveTurn, "no active turn"), nil
		}
		if refused := kernel.InputImagesRefusal(s.caps.Images, options.Images); refused != nil {
			return *refused, nil
		}
		s.active.steered = append(s.active.steered, input)
		return oar.Accepted(), nil
	}, kernel.RecordAt{}), nil
}

func (s *scriptedSession) Queue(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	body := oar.RequestBody{Kind: oar.RequestQueue, Input: input, InputID: options.InputID, Images: options.Images, Origin: options.Origin}
	return s.kernel.Control(body, func(oar.RawEvent) (oar.ResponseBody, error) {
		if refused := kernel.InputImagesRefusal(s.caps.Images, options.Images); refused != nil {
			return *refused, nil
		}
		if s.active == nil {
			s.run(input, options.Images)
		} else {
			s.queue = append(s.queue, queued{input: input, inputID: options.InputID, images: options.Images})
		}
		return oar.Accepted(), nil
	}, kernel.RecordAt{}), nil
}

func (s *scriptedSession) Withdraw(_ context.Context, inputID string) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// The turn-end drain takes its entry off before running it, so an entry still here was never sent.
	return s.kernel.Control(oar.RequestBody{Kind: oar.RequestWithdraw, InputID: inputID}, func(oar.RawEvent) (oar.ResponseBody, error) {
		return kernel.WithdrawHeld(&s.queue, inputID), nil
	}, kernel.RecordAt{}), nil
}

func (s *scriptedSession) Abort(context.Context) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kernel.Control(oar.RequestBody{Kind: oar.RequestAbort}, func(oar.RawEvent) (oar.ResponseBody, error) {
		if s.active == nil {
			return oar.Rejected(oar.CodeNoActiveTurn, "no active turn"), nil
		}
		s.abortActive()
		return oar.Accepted(), nil
	}, kernel.RecordAt{}), nil
}

func (s *scriptedSession) RawEvents(observer oar.RawEventObserver, cursor *oar.Cursor) oar.Unsubscribe {
	return s.kernel.RawEvents(observer, cursor)
}

func (s *scriptedSession) Records() []oar.RawEvent { return s.kernel.Records() }
func (s *scriptedSession) Graph() oar.SessionGraph { return s.kernel.Graph() }

func (s *scriptedSession) Dispose(context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.disposed {
		return nil
	}
	s.disposed = true
	request := s.kernel.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestDispose}, kernel.RecordAt{})
	s.queue = nil
	s.abortActive()
	code := 0
	s.kernel.Respond(request.ID, oar.ExitedBody(&code), kernel.RecordAt{})
	return nil
}

// ─── tasks (testing/scripted-tasks.ts) ─────────────────────────────────────

type scriptedTask struct {
	session *scriptedSession
	id      string
	open    bool
}

func (s *scriptedSession) startTask(spec TaskSpec, live bool) Task {
	s.tasks++
	task := &scriptedTask{session: s, id: fmt.Sprintf("task-%d", s.tasks), open: live}
	if live {
		started := oar.TaskStarted{TaskID: task.id, TaskType: spec.TaskType, Description: spec.Description, Background: spec.Background}
		native := map[string]any{"taskId": task.id, "taskType": spec.TaskType}
		if spec.Description != "" {
			native["description"] = spec.Description
		}
		if spec.Background != nil {
			native["background"] = *spec.Background
		}
		s.frame("scripted/task_started", native, started)
	}
	return task
}

func (t *scriptedTask) ID() string { return t.id }

func (t *scriptedTask) Update(status oar.TaskStatus, description *string) {
	s := t.session
	s.mu.Lock()
	defer s.mu.Unlock()
	if !t.open || s.disposed {
		return
	}
	native := map[string]any{"taskId": t.id}
	if status != "" {
		native["status"] = status
	}
	if description != nil {
		native["description"] = *description
	}
	s.frame("scripted/task_updated", native, oar.TaskUpdated{TaskID: t.id, Status: status, Description: description})
}

func (t *scriptedTask) End(status, summary, outputFile string) {
	s := t.session
	s.mu.Lock()
	defer s.mu.Unlock()
	if !t.open || s.disposed {
		return
	}
	t.open = false
	if status == "" {
		status = "completed"
	}
	native := map[string]any{"taskId": t.id, "status": status}
	if summary != "" {
		native["summary"] = summary
	}
	if outputFile != "" {
		native["outputFile"] = outputFile
	}
	s.frame("scripted/task_ended", native, oar.TaskEnded{TaskID: t.id, Status: status, Summary: summary, OutputFile: outputFile})
}
