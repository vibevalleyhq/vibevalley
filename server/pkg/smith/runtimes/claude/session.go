package claude

import (
	"context"
	"errors"
	"fmt"
	"sync"

	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// The claude session adapter (session.ts).
//
// Stream-json writes can steer the active turn or land as the next turn;
// native system/init ... result frames establish those boundaries. The
// interrupt's control_response acknowledges abort, not turn completion. The
// adapter owns pending controls and queue drain; projection owns facts.
// Open readbacks are private plumbing: get_settings contains user config
// and credentials, initialize and a resume's get_usage (its token baseline)
// account details. All are consumed before projection, as is the
// unrecorded ContextBreakdown query answer.
//
// Concurrency (PORTING.md): one lock, s.mu, guards all adapter state. The
// line and exit handlers, control decisions and the abort fallback's timer
// run with it held; it is released around every wait (an abort's
// control_response, open readbacks, the process exit on dispose).

// abortFallbackTimeout bounds an interrupt claude does not answer; a var so tests can shorten it.
var abortFallbackTimeout = shared.DefaultAbortFallbackTimeout

type heldQueueEntry struct {
	request oar.RawEvent
	input   string
	inputID string
	images  []kernel.LoadedImage
}

func (e heldQueueEntry) HeldInputID() string { return e.inputID }

type pendingInterrupt struct {
	control *kernel.PendingControl
	refuse  func()
}

type claudeSession struct {
	mu    sync.Mutex
	k     *kernel.Kernel
	child claudeProcess

	// The prompt request whose turn is running; nil while idle. Spontaneous
	// turns (a drained queue message) run with no request.
	active *oar.RawEvent
	// True while claude is executing a turn we did not prompt (queue drain or task notification).
	spontaneous bool
	projection  projectionState
	disposed    bool

	// claude cannot hold input for a LATER turn natively (an active-turn
	// write steers), so queueing is adapter-held: drained one message per
	// turn end, and an entry can be withdrawn by its inputId until then.
	writtenQueues   map[string]oar.RawEvent
	heldQueue       []heldQueueEntry
	canCancelQueued bool
	abortFallback   *shared.AbortFallback
	// Pending interrupts by request id, in arrival order (a JS Map).
	pendingInterrupts     map[string]pendingInterrupt
	pendingInterruptOrder []string
	disposeRequest        *oar.RawEvent
	readback              *openSettings
	breakdown             *contextBreakdownReader
	interruptCounter      int
	// The abort fallback ended claude's stdin (TS child.stdin.writableEnded).
	stdinEnded bool
}

var claudeCapabilities = oar.SessionCapabilities{QueueDurable: false, Attribution: "attributed", Images: true}

// Session opens a claude session (claudeSession).
var Session oar.StartSession = kernel.WithSessionCredentials(openClaudeSession)

func openClaudeSession(ctx context.Context, installation oar.AvailableInstallation, options oar.SessionOptions, credentials kernel.Credentials) (oar.Session, error) {
	if installation.Via != "executable" {
		return nil, errors.New("The claude session adapter needs an executable installation")
	}
	// Session identity is claude's own: we either choose it up front
	// (--session-id) or reattach to an existing one (--resume), so Session.ID
	// is always the runtime-native persistent id.
	sessionID := options.Resume
	if sessionID == "" {
		sessionID = observe.NewUUID()
	}
	child, err := launchClaude(installation.Command, sessionID, options)
	if err != nil {
		return nil, err
	}
	s := &claudeSession{
		k:                 credentials.Kernel(sessionID),
		child:             child,
		writtenQueues:     map[string]oar.RawEvent{},
		pendingInterrupts: map[string]pendingInterrupt{},
	}
	if options.Resume == "" {
		s.projection = initialClaudeProjection()
	} else {
		s.projection = resumedClaudeProjection()
	}
	s.abortFallback = shared.NewAbortFallback(func() {
		s.stdinEnded = true
		child.Kill()
	}, abortFallbackTimeout, &s.mu)
	s.readback = newOpenSettings(child, &s.mu)
	s.breakdown = newContextBreakdownReader(child, &s.mu, func() bool { return s.stdinEnded })
	// Drive the pure projection fold, applying its commands to the kernel.
	child.OnLine(s.onLine)
	child.OnExit(s.onExit)

	if err := s.readback.confirm(options, credentials.Text); err != nil {
		return nil, err
	}
	if options.Resume != "" {
		// Before the first turn: where this Session's share of the running total
		// the resumed process continues starts (token_usage.go).
		baseline := s.readback.usageBaseline()
		s.mu.Lock()
		s.projection = claudeUsageBaselined(s.projection, baseline)
		s.mu.Unlock()
	}
	return credentials.Seal(s), nil
}

func (s *claudeSession) busy() bool { return s.active != nil || s.spontaneous }

func (s *claudeSession) activeInputID() string {
	if s.active == nil {
		return ""
	}
	return s.active.Request.InputID
}

// onLine is one stdout line: one JS tick, under s.mu.
func (s *claudeSession) onLine(line string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	message, ok := parseNative([]byte(line))
	if !ok {
		return
	}
	record := message.Record
	if record["type"] == "system" && record["subtype"] == "init" {
		if _, child := record["parent_tool_use_id"].(string); !child {
			if capabilities, ok := record["capabilities"].([]any); ok {
				s.canCancelQueued = false
				for _, capability := range capabilities {
					if capability == "interrupt_cancel_queued_v1" {
						s.canCancelQueued = true
					}
				}
			}
		}
	}
	if s.readback.consume(record) || s.breakdown.consume(record) {
		return
	}
	next, commands := foldClaudeStdout(s.projection, message)
	s.projection = next
	commandUUID, hasUUID := record["command_uuid"].(string)
	if record["type"] == "command_lifecycle" && hasUUID {
		switch record["state"] {
		case "queued":
			if queued, ok := s.writtenQueues[commandUUID]; ok && s.active == nil {
				s.active = &queued
			}
		case "completed", "cancelled":
			delete(s.writtenQueues, commandUUID)
		case "started":
			if s.active != nil && s.activeInputID() != "" && commandUUID == s.activeInputID() {
				s.spontaneous = false
			}
		}
	}
	ended, dropped := false, false
	for _, command := range commands {
		switch command.Kind {
		case "frame":
			root := len(command.AgentPath) == 0
			// Projection can establish a spontaneous start at init, or at a
			// later queued receipt that proves the init did not own our prompt.
			for _, event := range command.Body.Events {
				if active, ok := event.(oar.TurnActive); ok && root && active.InputID == "" {
					s.spontaneous = true
				}
			}
			s.k.Frame(command.Body, kernel.RecordAt{AgentPath: command.AgentPath})
			if !root {
				break
			}
			var cancelled *oar.InputDropped
			for _, event := range command.Body.Events {
				if _, ok := event.(oar.TurnEnded); ok {
					ended = true
				}
				if drop, ok := event.(oar.InputDropped); ok && cancelled == nil {
					cancelled = &drop
				}
			}
			if cancelled != nil {
				dropped = true
				delete(s.writtenQueues, cancelled.InputID)
				if s.active != nil && s.activeInputID() != "" && cancelled.InputID == s.activeInputID() {
					s.active = nil
				}
			}
		case "respond":
			if pending, ok := s.pendingInterrupts[command.RequestID]; ok {
				s.forgetInterrupt(command.RequestID)
				if command.Response.Kind == oar.ResponseRejected {
					pending.refuse()
				}
				pending.control.Settle(command.Response)
			} else {
				// Exit may precede the last stdout bytes. Preserve a late or
				// duplicate native reply, but never answer a request twice.
				s.k.Frame(oar.FrameBody{Type: "control_response", Native: message.raw}, kernel.RecordAt{})
			}
		case "toApp":
			s.k.Request(oar.ToApp, oar.RequestBody{Kind: oar.RequestNative, Type: command.Type, Native: command.Native}, kernel.RecordAt{ID: command.ID})
		}
	}
	if ended || (dropped && !s.busy()) {
		s.abortFallback.Clear()
		if s.projection.PendingInputID == "" {
			s.active = nil
		}
		s.spontaneous = false
		if !s.disposed && !s.busy() && len(s.heldQueue) > 0 {
			next := s.heldQueue[0]
			s.heldQueue = s.heldQueue[1:]
			if next.inputID != "" {
				s.writtenQueues[next.inputID] = next.request
			}
			s.projection = claudePrompted(s.projection, next.inputID, false)
			s.child.Write(claudeUserMessage(next.input, next.inputID, next.images))
		}
	}
}

func (s *claudeSession) forgetInterrupt(requestID string) bool {
	if _, ok := s.pendingInterrupts[requestID]; !ok {
		return false
	}
	delete(s.pendingInterrupts, requestID)
	for index, id := range s.pendingInterruptOrder {
		if id == requestID {
			s.pendingInterruptOrder = append(s.pendingInterruptOrder[:index:index], s.pendingInterruptOrder[index+1:]...)
			break
		}
	}
	return true
}

func (s *claudeSession) onExit(code *int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.abortFallback.Clear()
	// An exit before fallback still precedes the rejected pending controls.
	requestID := ""
	if s.disposeRequest != nil {
		requestID = s.disposeRequest.ID
	}
	s.k.Respond(requestID, oar.ExitedBody(code), kernel.RecordAt{})
	s.active = nil
	s.spontaneous = false
	for _, id := range append([]string(nil), s.pendingInterruptOrder...) {
		pending := s.pendingInterrupts[id]
		s.forgetInterrupt(id)
		pending.control.Settle(oar.Rejected(oar.CodeRuntimeExited, "runtime exited"))
	}
	s.readback.exited(code)
	s.breakdown.exited()
}

func (s *claudeSession) ID() string                            { return s.k.SessionID() }
func (s *claudeSession) Capabilities() oar.SessionCapabilities { return claudeCapabilities }

func inputBody(kind oar.RequestKind, input string, options oar.InputOptions) oar.RequestBody {
	return oar.RequestBody{Kind: kind, Input: input, InputID: options.InputID, Images: options.Images, Origin: options.Origin}
}

func (s *claudeSession) Prompt(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.k.Control(inputBody(oar.RequestPrompt, input, options), func(request oar.RawEvent) (oar.ResponseBody, error) {
		if s.busy() {
			return oar.Rejected(oar.CodeBusy, "busy"), nil
		}
		return kernel.WithInputImages(claudeCapabilities.Images, options.Images, func(images []kernel.LoadedImage) (oar.ResponseBody, error) {
			s.active = &request
			s.projection = claudePrompted(s.projection, options.InputID, true)
			s.child.Write(claudeUserMessage(input, options.InputID, images))
			return oar.Accepted(), nil
		})
	}, kernel.RecordAt{}), nil
}

func (s *claudeSession) Steer(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.k.Control(inputBody(oar.RequestSteer, input, options), func(oar.RawEvent) (oar.ResponseBody, error) {
		if !s.busy() {
			return oar.Rejected(oar.CodeNoActiveTurn, "not_steerable: no active turn"), nil
		}
		return kernel.WithInputImages(claudeCapabilities.Images, options.Images, func(images []kernel.LoadedImage) (oar.ResponseBody, error) {
			s.child.Write(claudeUserMessage(input, options.InputID, images))
			return oar.Accepted(), nil
		})
	}, kernel.RecordAt{}), nil
}

func (s *claudeSession) Queue(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.k.Control(inputBody(oar.RequestQueue, input, options), func(request oar.RawEvent) (oar.ResponseBody, error) {
		return kernel.WithInputImages(claudeCapabilities.Images, options.Images, func(images []kernel.LoadedImage) (oar.ResponseBody, error) {
			if s.busy() {
				s.heldQueue = append(s.heldQueue, heldQueueEntry{request: request, input: input, inputID: options.InputID, images: images})
			} else {
				if options.InputID != "" {
					s.writtenQueues[options.InputID] = request
				}
				s.projection = claudePrompted(s.projection, options.InputID, false)
				s.child.Write(claudeUserMessage(input, options.InputID, images))
			}
			return oar.Accepted(), nil
		})
	}, kernel.RecordAt{}), nil
}

func (s *claudeSession) Withdraw(_ context.Context, inputID string) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.k.Control(oar.RequestBody{Kind: oar.RequestWithdraw, InputID: inputID}, func(oar.RawEvent) (oar.ResponseBody, error) {
		return kernel.WithdrawHeld(&s.heldQueue, inputID), nil
	}, kernel.RecordAt{}), nil
}

// Abort interrupts the active turn. The interrupt's outcome is claude's
// control_response, which the fold routes to THIS request id; the turn's
// end is claude's result frame. Recorded by hand (not Control) because
// claude's control_response is the answer, so the reachability gate is
// applied here explicitly.
func (s *claudeSession) Abort(ctx context.Context) (oar.ControlResult, error) {
	s.mu.Lock()
	s.interruptCounter++
	requestID := fmt.Sprintf("interrupt-%d", s.interruptCounter)
	pending := s.k.BeginControl(oar.RequestBody{Kind: oar.RequestAbort}, kernel.RecordAt{ID: requestID})
	cancelQueued := s.canCancelQueued && len(s.projection.UnstartedInputs) > 0
	if pending.Settled() || (!s.busy() && !cancelQueued) {
		pending.Settle(oar.Rejected(oar.CodeNoActiveTurn, "no active turn"))
		s.mu.Unlock()
		return pending.Wait(ctx)
	}
	s.projection = claudeAbortRequested(s.projection)
	// A repeated abort during termination is taken over synchronously too.
	s.pendingInterrupts[requestID] = pendingInterrupt{control: pending, refuse: func() {}}
	s.pendingInterruptOrder = append(s.pendingInterruptOrder, requestID)
	refuse := s.abortFallback.Arm(func() {
		if s.forgetInterrupt(requestID) {
			pending.Settle(oar.Accepted())
		}
	})
	if _, ok := s.pendingInterrupts[requestID]; ok {
		s.pendingInterrupts[requestID] = pendingInterrupt{control: pending, refuse: refuse}
	}
	interrupt := map[string]any{"subtype": "interrupt"}
	if cancelQueued {
		interrupt["cancel_queued"] = true
	}
	s.child.Write(jsonText(controlRequest{Type: "control_request", RequestID: requestID, Request: interrupt}) + "\n")
	s.mu.Unlock()
	return pending.Wait(ctx)
}

func (s *claudeSession) RawEvents(observer oar.RawEventObserver, cursor *oar.Cursor) oar.Unsubscribe {
	return s.k.RawEvents(observer, cursor)
}

func (s *claudeSession) Records() []oar.RawEvent { return s.k.Records() }
func (s *claudeSession) Graph() oar.SessionGraph { return s.k.Graph() }

func (s *claudeSession) Resources(context.Context) (*oar.SessionResources, error) {
	resources := s.child.Resources()
	if resources == nil {
		return nil, nil
	}
	return &oar.SessionResources{RSS: resources.RSS, Processes: resources.Processes}, nil
}

func (s *claudeSession) ContextBreakdown(ctx context.Context) (*oar.ContextBreakdown, error) {
	return s.breakdown.read(ctx)
}

// Dispose records the dispose, kills claude and its tree and waits for the
// exit, whose response onExit records. It always settles, whatever ctx says.
func (s *claudeSession) Dispose(context.Context) error {
	s.mu.Lock()
	if s.disposed {
		s.mu.Unlock()
		return nil
	}
	s.disposed = true
	// stdin ends now: no query may write to it any more.
	s.breakdown.exited()
	// Only an observed exit can say so before this dispose is recorded.
	gone := s.k.Unreachable() != nil
	request := s.k.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestDispose}, kernel.RecordAt{})
	s.disposeRequest = &request
	if gone {
		// The exit is already recorded; nothing is left to release.
		s.k.Respond(request.ID, oar.Accepted(), kernel.RecordAt{})
		s.mu.Unlock()
		return nil
	}
	s.mu.Unlock()
	s.child.Kill()
	<-s.child.Exited()
	return nil
}
