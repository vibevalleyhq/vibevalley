package acp

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
)

// ACP mapping onto the record stream (session.ts; shared by grok, kimi,
// opencode and antigravity, profiles carry the vendor bits):
//   - every `session/update` is ONE frame, native verbatim, for WHATEVER
//     session id it names: a foreign id is a derived child session (records.go).
//   - listed vendor notifications are recorded verbatim except credential redaction.
//   - runtime→app requests (permission, terminal) are toApp request records;
//     OAR's automatic answer is the matching `answered` response (client_app.go).
//   - prompt / steer / queue / withdraw / abort / dispose are toRuntime
//     requests answered accepted-or-rejected; the turn's end is the runtime's
//     own prompt answer (turns.go) or the process exit OAR observed (`exited`).

type session struct {
	profile  Profile
	process  *Process
	terminal *TerminalHost
	opened   Opened
	caps     oar.SessionCapabilities

	mu            sync.Mutex
	kernel        *kernel.Kernel
	recorder      *Recorder
	turns         *Turns
	disposeID     string
	disposed      bool
	disposeSettle chan struct{}
}

// steerable is a session whose profile can inject (oar.Steerer).
type steerable struct{ *session }

// Session is the StartSession of an ACP runtime with this profile (acpSession).
func Session(profile Profile) oar.StartSession {
	return kernel.WithSessionCredentials(func(ctx context.Context, installation oar.AvailableInstallation, options oar.SessionOptions, credentials kernel.Credentials) (oar.Session, error) {
		return open(ctx, profile, installation, options, credentials)
	})
}

func open(ctx context.Context, profile Profile, installation oar.AvailableInstallation, options oar.SessionOptions, credentials kernel.Credentials) (oar.Session, error) {
	if !installation.IsExecutable() {
		return nil, errors.New("ACP runtimes require an executable installation")
	}
	if profile.ValidateOptions != nil {
		if err := profile.ValidateOptions(options); err != nil {
			return nil, err
		}
	}
	// SessionOptions.MCPServers go out in the open request (mcp_servers.go):
	// a list with an empty or repeated name fails before anything starts,
	// and an open that fails reports no credential they carry.
	withoutCredentials, err := McpOpenGuard(options.MCPServers, credentials.Text)
	if err != nil {
		return nil, err
	}
	args := LaunchArgs(profile, options)
	environment := shared.Environment(options.Env)
	s := &session{profile: profile, terminal: NewTerminalHost(options.Cwd, environment, TerminalHostOptions{ShellCommand: profile.TerminalShellCommand}), disposeSettle: make(chan struct{})}
	// The recorder queues everything until the handshake reveals the
	// session id and the kernel can be bound (records.go).
	gate := NewUsageGate()
	tokenUsage := NewTokenUsage(profile)
	opening := NewOpening()
	s.recorder = NewRecorder(gate, profile.AttributeUpdate, tokenUsage)
	s.recorder.modelName = profile.ModelName
	client := NewClientApp(s.terminal, ClientHooks{
		Update: func(params json.RawMessage) {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.recorder.Update(params)
		},
		Extension: func(method string, params json.RawMessage, afterOpen bool) {
			if profile.RedactExtensionNotification != nil {
				params = profile.RedactExtensionNotification(method, params)
			}
			s.mu.Lock()
			defer s.mu.Unlock()
			s.recorder.Extension(method, params, afterOpen)
		},
		Requested: func(id, method string, params json.RawMessage) {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.recorder.Requested(id, method, params)
		},
		Answered: func(id string, reply any) {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.recorder.Answered(id, reply)
		},
		ExtensionNotifications: profile.ExtensionNotifications,
	})
	process, err := StartProcess(installation.Command, args, client, ProcessOptions{Dir: options.Cwd, Env: environment, Redact: credentials.Text, Opening: opening})
	if err != nil {
		return nil, withoutCredentials(err)
	}
	s.process = process
	opened, err := OpenSession(ctx, process, profile, options, func(step OpenStep) {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.recorder.Step(step.Method, step.Response)
	})
	if err != nil {
		process.Kill()
		<-process.Exited()
		s.terminal.Dispose()
		return nil, withoutCredentials(err)
	}
	s.opened = opened
	images := TakesImages(opened.Initialized)
	if profile.Capabilities.Images != nil {
		images = *profile.Capabilities.Images
	}
	s.caps = oar.SessionCapabilities{QueueDurable: profile.Capabilities.QueueDurable, Attribution: profile.Capabilities.Attribution, Images: images}
	var promptMeta jsonx.Record
	if profile.PromptMeta != nil {
		promptMeta = profile.PromptMeta(options)
	}
	s.mu.Lock()
	s.kernel = credentials.Kernel(opened.SessionID)
	s.recorder.Bind(s.kernel)
	s.turns = NewTurns(TurnsDeps{Lock: &s.mu, Kernel: s.kernel, Process: process, Profile: profile, Gate: gate, Images: images, PromptMeta: promptMeta, PromptUsage: tokenUsage.Prompt})
	s.mu.Unlock()
	process.OnExit(func(code *int) {
		go s.terminal.Dispose()
		s.mu.Lock()
		defer s.mu.Unlock()
		// An outcome only OAR observes: answers our dispose when we caused
		// the exit, stands alone (requestId "") when the runtime died on its own.
		s.kernel.Respond(s.disposeID, oar.ExitedBody(code), kernel.RecordAt{})
		s.turns.OnExit()
	})
	if profile.SteerParams != nil {
		return credentials.Seal(steerable{s}), nil
	}
	return credentials.Seal(s), nil
}

// control lets an exit already under way land first: `Closed` flips before
// the exit observer records the `exited` response, and a control landing in
// that window is decided by the kernel's gate, not here.
func (s *session) control(body oar.RequestBody, decide kernel.Decide) oar.ControlResult {
	if s.process.Closed() {
		s.mu.Lock()
		reachable := s.kernel.Unreachable() == nil
		s.mu.Unlock()
		if reachable {
			<-s.process.Exited()
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kernel.Control(body, decide, kernel.RecordAt{})
}

func inputBody(kind oar.RequestKind, input string, options oar.InputOptions) oar.RequestBody {
	return oar.RequestBody{Kind: kind, Input: input, InputID: options.InputID, Images: options.Images, Origin: options.Origin}
}

func (s *session) ID() string                            { return s.kernel.SessionID() }
func (s *session) Capabilities() oar.SessionCapabilities { return s.caps }

func (s *session) Prompt(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	return s.control(inputBody(oar.RequestPrompt, input, options), func(request oar.RawEvent) (oar.ResponseBody, error) {
		if s.turns.Active() != nil {
			return oar.Rejected(oar.CodeBusy, "busy"), nil
		}
		return s.turns.Begin(&request, input, options.Images), nil
	}), nil
}

func (s steerable) Steer(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	return s.control(inputBody(oar.RequestSteer, input, options), func(oar.RawEvent) (oar.ResponseBody, error) {
		state := s.turns.Active()
		if state == nil {
			return oar.Rejected(oar.CodeNoActiveTurn, "not_steerable: no active turn"), nil
		}
		return s.turns.Steer(state, input, options, s.profile.SteerParams(input)), nil
	}), nil
}

// Queue holds input here (turns.go), not by the vendor: an entry can be taken back until the drain sends it.
func (s *session) Queue(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := s.controlLocked(inputBody(oar.RequestQueue, input, options), func(oar.RawEvent) (oar.ResponseBody, error) {
		return s.turns.Hold(input, options.Images, options.InputID), nil
	})
	// After the answer is recorded and before the caller sees it.
	s.turns.DrainHeld()
	return result, nil
}

func (s *session) controlLocked(body oar.RequestBody, decide kernel.Decide) oar.ControlResult {
	if s.process.Closed() && s.kernel.Unreachable() == nil {
		s.mu.Unlock()
		<-s.process.Exited()
		s.mu.Lock()
	}
	return s.kernel.Control(body, decide, kernel.RecordAt{})
}

func (s *session) Withdraw(_ context.Context, inputID string) (oar.ControlResult, error) {
	return s.control(oar.RequestBody{Kind: oar.RequestWithdraw, InputID: inputID}, func(oar.RawEvent) (oar.ResponseBody, error) {
		return s.turns.Withdraw(inputID), nil
	}), nil
}

func (s *session) Abort(context.Context) (oar.ControlResult, error) {
	return s.control(oar.RequestBody{Kind: oar.RequestAbort}, func(oar.RawEvent) (oar.ResponseBody, error) {
		state := s.turns.Active()
		if state == nil {
			return oar.Rejected(oar.CodeNoActiveTurn, "no active turn"), nil
		}
		return s.turns.Abort(state), nil
	}), nil
}

func (s *session) RawEvents(observer oar.RawEventObserver, cursor *oar.Cursor) oar.Unsubscribe {
	return s.kernel.RawEvents(observer, cursor)
}

func (s *session) Records() []oar.RawEvent { return s.kernel.Records() }
func (s *session) Graph() oar.SessionGraph { return s.kernel.Graph() }

// Resources is the agent's memory with everything it started; nil once it exited.
func (s *session) Resources(context.Context) (*oar.SessionResources, error) {
	return s.process.Resources(), nil
}

func (s *session) Dispose(ctx context.Context) error {
	s.mu.Lock()
	if s.disposed {
		// Already released: the stream holds our dispose request.
		s.mu.Unlock()
		return nil
	}
	s.disposed = true
	// Read BEFORE this dispose is recorded: only an observed exit can say so
	// here, and it is the stream's word, not an adapter flag.
	gone := s.kernel.Unreachable() != nil
	request := s.kernel.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestDispose}, kernel.RecordAt{})
	s.disposeID = request.ID
	if gone {
		// The exit is already recorded (an unrequested `exited`, requestId
		// ""): nothing is left to release, so the dispose is answered here.
		s.kernel.Respond(request.ID, oar.Accepted(), kernel.RecordAt{})
		s.mu.Unlock()
		s.terminal.Dispose()
		return nil
	}
	if state := s.turns.Active(); state != nil && !s.process.Closed() {
		s.turns.Abort(state)
	}
	closed := s.process.Closed()
	s.mu.Unlock()
	if s.opened.SupportsClose && !closed {
		closeCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
		_ = CloseSession(closeCtx, s.process, s.ID())
		cancel()
	}
	s.process.Kill()
	<-s.process.Exited()
	s.terminal.Dispose()
	return nil
}
