package morph

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
)

// One OAR session is one morph Console topic (Session.ID = topic id),
// driven through the Console Runtime API (session.ts): prompt and steer are
// `POST /tasks`, abort `POST /tasks/{id}/stop`, the queue is held here.

const disposeSettle = 3 * time.Second

// RefusedSessionOptions are the options morph cannot honor.
var RefusedSessionOptions = oar.RefusedSessionOptions{
	oar.OptionSystemPrompt:       "The morph Runtime API has no system prompt override",
	oar.OptionAppendSystemPrompt: "The morph Runtime API has no system prompt override",
	oar.OptionEnv:                "morph runs tools inside its Console process, which a session neither starts nor owns",
	oar.OptionMCPServers:         "OAR does not attach MCP servers to morph: no per-session channel is known",
	oar.OptionLaunchArgs:         "morph sessions run in its Console process, which a session neither starts nor owns",
	oar.OptionName:               "OAR knows no morph session name setting",
}

type held struct {
	input   string
	inputID string
}

func (h held) HeldInputID() string { return h.inputID }

func refusal(err error) oar.ResponseBody {
	var refused *RefusalError
	if errors.As(err, &refused) {
		code := oar.CodeError
		if refused.Refused {
			code = oar.CodeRuntimeRefused
		}
		body := oar.Rejected(code, refused.Message)
		body.Native = refused.Native
		return body
	}
	return oar.Rejected(oar.CodeError, err.Error())
}

// AcquireFunc is how a session gets its Console; tests hand in a scripted one.
type AcquireFunc func(ctx context.Context, command, stateDir string) (Lease, error)

type session struct {
	mu       sync.Mutex
	kernel   *kernel.Kernel
	lease    Lease
	client   *Client
	tracker  *tracker
	options  oar.SessionOptions
	topicID  string
	held     []held
	disposed bool
	caps     oar.SessionCapabilities
	sealed   oar.Session
}

// SessionWith opens morph sessions through acquire.
func SessionWith(acquire AcquireFunc) oar.StartSession {
	return func(ctx context.Context, installation oar.AvailableInstallation, options oar.SessionOptions) (oar.Session, error) {
		if !installation.IsExecutable() {
			return nil, errors.New("The morph session adapter needs an executable installation")
		}
		if err := shared.RefuseSessionOptions(RefusedSessionOptions, options); err != nil {
			return nil, err
		}
		if options.Effort != "" {
			return nil, fmt.Errorf("morph's Runtime API has no reasoning-effort channel, so effort %s cannot be applied", options.Effort)
		}
		lease, err := acquire(ctx, installation.Command, HostStateDir())
		if err != nil {
			return nil, err
		}
		client := lease.Client()
		topicID, err := prepareTopic(ctx, client, options)
		if err != nil {
			lease.Release()
			return nil, err
		}
		s := &session{kernel: kernel.New(topicID), lease: lease, client: client, options: options, topicID: topicID, caps: oar.SessionCapabilities{Attribution: "opaque"}}
		s.tracker = &tracker{mu: &s.mu, client: client, kernel: s.kernel, topicID: topicID, onIdle: s.idle}
		if !lease.Owned() {
			s.tracker.onUnreachable = func() { s.lost(nil) }
		}
		lease.OnExit(func(code *int) {
			s.mu.Lock()
			defer s.mu.Unlock()
			s.lost(code)
		})
		s.sealed = kernel.Seal(s)
		return s.sealed, nil
	}
}

// Session is morph's StartSession over Acquire.
var Session = SessionWith(Acquire)

func prepareTopic(ctx context.Context, client *Client, options oar.SessionOptions) (string, error) {
	if options.Model != "" {
		if err := CheckProfile(ctx, client, options.Model); err != nil {
			return "", err
		}
	}
	topicID, err := OpenTopic(ctx, client, options.Resume)
	if err != nil {
		return "", err
	}
	if _, err := client.Expect(ctx, "PUT", "/workspace", map[string]any{"topic_id": topicID, "workspace_dir": options.Cwd}); err != nil {
		return "", err
	}
	return topicID, nil
}

// lost: the runtime went away without anyone asking; under mu.
func (s *session) lost(code *int) {
	if s.kernel.Unreachable() == nil {
		s.kernel.Respond("", oar.ExitedBody(code), kernel.RecordAt{})
	}
	s.tracker.close()
	s.held = nil
}

// idle drains one held input; under mu.
func (s *session) idle() {
	if s.disposed || len(s.held) == 0 {
		return
	}
	next := s.held[0]
	s.held = s.held[1:]
	// The input was taken over at queue time; a send that fails leaves no turn.
	go func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		s.send(next.input)
	}()
}

func (s *session) body(task string) map[string]any {
	body := map[string]any{"task": task, "topic_id": s.topicID, "workspace_dir": s.options.Cwd}
	if s.options.Model != "" {
		body["llm_profile"] = s.options.Model
	}
	return body
}

// send submits a task; called with mu held, released around the request.
func (s *session) send(input string) oar.ResponseBody {
	s.mu.Unlock()
	answer, native, err := SubmitTask(context.Background(), s.client, s.body(input))
	s.mu.Lock()
	if err != nil {
		return refusal(err)
	}
	s.tracker.follow(CarrierTask(answer))
	return oar.ResponseBody{Kind: oar.ResponseAccepted, Native: native}
}

func (s *session) ID() string                            { return s.kernel.SessionID() }
func (s *session) Capabilities() oar.SessionCapabilities { return s.caps }

func inputBody(kind oar.RequestKind, input string, options oar.InputOptions) oar.RequestBody {
	return oar.RequestBody{Kind: kind, Input: input, InputID: options.InputID, Images: options.Images, Origin: options.Origin}
}

func (s *session) Prompt(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	// Busy is the status fold's word as the request is recorded, so the
	// contract's invariant holds by construction.
	running := s.sealed.Status().Value.IsRunning()
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kernel.Control(inputBody(oar.RequestPrompt, input, options), func(oar.RawEvent) (oar.ResponseBody, error) {
		if running {
			return oar.Rejected(oar.CodeBusy, "busy"), nil
		}
		if refused := kernel.InputImagesRefusal(s.caps.Images, options.Images); refused != nil {
			return *refused, nil
		}
		return s.send(input), nil
	}, kernel.RecordAt{}), nil
}

func (s *session) Steer(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kernel.Control(inputBody(oar.RequestSteer, input, options), func(oar.RawEvent) (oar.ResponseBody, error) {
		if !s.tracker.busy() {
			return oar.Rejected(oar.CodeNoActiveTurn, "not_steerable: no active turn"), nil
		}
		if refused := kernel.InputImagesRefusal(s.caps.Images, options.Images); refused != nil {
			return *refused, nil
		}
		s.mu.Unlock()
		answer, native, err := SubmitTask(context.Background(), s.client, s.body(input))
		s.mu.Lock()
		if err != nil {
			return refusal(err), nil
		}
		if CarrierTask(answer) == answer["id"] && answer["status"] == "done" {
			// Console found the run but did not hold the input for it.
			body := oar.Rejected(oar.CodeRuntimeRefused, "not_steerable: morph did not queue the input for the running task")
			body.Native = native
			return body, nil
		}
		s.tracker.follow(CarrierTask(answer))
		return oar.ResponseBody{Kind: oar.ResponseAccepted, Native: native}, nil
	}, kernel.RecordAt{}), nil
}

func (s *session) Queue(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kernel.Control(inputBody(oar.RequestQueue, input, options), func(oar.RawEvent) (oar.ResponseBody, error) {
		if refused := kernel.InputImagesRefusal(s.caps.Images, options.Images); refused != nil {
			return *refused, nil
		}
		if s.tracker.busy() {
			s.held = append(s.held, held{input: input, inputID: options.InputID})
			return oar.Accepted(), nil
		}
		return s.send(input), nil
	}, kernel.RecordAt{}), nil
}

func (s *session) Withdraw(_ context.Context, inputID string) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kernel.Control(oar.RequestBody{Kind: oar.RequestWithdraw, InputID: inputID}, func(oar.RawEvent) (oar.ResponseBody, error) {
		return kernel.WithdrawHeld(&s.held, inputID), nil
	}, kernel.RecordAt{}), nil
}

func (s *session) Abort(context.Context) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kernel.Control(oar.RequestBody{Kind: oar.RequestAbort}, func(oar.RawEvent) (oar.ResponseBody, error) {
		active := s.tracker.active()
		if active == "" {
			return oar.Rejected(oar.CodeNoActiveTurn, "no active turn"), nil
		}
		s.mu.Unlock()
		body, err := StopTask(context.Background(), s.client, active)
		s.mu.Lock()
		return body, err
	}, kernel.RecordAt{}), nil
}

func (s *session) RawEvents(observer oar.RawEventObserver, cursor *oar.Cursor) oar.Unsubscribe {
	return s.kernel.RawEvents(observer, cursor)
}

func (s *session) Records() []oar.RawEvent { return s.kernel.Records() }
func (s *session) Graph() oar.SessionGraph { return s.kernel.Graph() }

func (s *session) Dispose(ctx context.Context) error {
	s.mu.Lock()
	if s.disposed {
		s.mu.Unlock()
		return nil
	}
	s.disposed = true
	gone := s.kernel.Unreachable() != nil
	request := s.kernel.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestDispose}, kernel.RecordAt{})
	s.held = nil
	active := s.tracker.active()
	s.mu.Unlock()
	if !gone && active != "" {
		// The task's own `canceled` ends the turn in the stream, if it comes in time.
		_, _ = StopTask(ctx, s.client, active)
		s.tracker.settle(disposeSettle)
	}
	s.mu.Lock()
	s.tracker.close()
	s.mu.Unlock()
	stopped, code := s.lease.Release()
	s.mu.Lock()
	defer s.mu.Unlock()
	// A Console this release stopped exits as the answer to the dispose; one
	// still serving other sessions, or the user's own, was only let go.
	if !stopped || gone {
		s.kernel.Respond(request.ID, oar.Accepted(), kernel.RecordAt{})
	} else {
		s.kernel.Respond(request.ID, oar.ExitedBody(code), kernel.RecordAt{})
	}
	return nil
}
