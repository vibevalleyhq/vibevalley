package pi

import (
	"context"
	"encoding/json"
	"errors"
	"regexp"
	"sync"
	"time"

	"vibevalley/pkg/smith/internal/executable"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
)

// pi over its RPC mode (session.ts, adapted): every pi event is one frame;
// pi's own agent_settled is the turn end; a prompt is accepted when pi
// answers its `prompt` command; steer is pi's `steer`; abort is pi's `abort`;
// the queue is adapter-held and drained one input per turn end. Where TS
// runs pi in process, the Go port runs pi's SDK in a Node host (host.go)
// that speaks the same frames, and records the host's exit.

const (
	openTimeout    = 30 * time.Second
	disposeTimeout = 10 * time.Second
)

type heldInput struct {
	input   string
	inputID string
	images  []kernel.LoadedImage
}

func (h heldInput) HeldInputID() string { return h.inputID }

type session struct {
	kernel  *kernel.Kernel
	process *executable.LineProcess
	client  *rpcClient
	caps    oar.SessionCapabilities
	creds   kernel.Credentials

	mu         sync.Mutex
	projection ProjectionState
	// A run is in progress: from an accepted prompt (or a drained queue input,
	// or an adopted agent_start) until pi's own agent_settled.
	running bool
	// pi has started the current run (agent_start): an abort can reach it.
	started bool
	// Identity of the latest launched prompt, so a late answer to an older
	// one cannot be misread as the current run's.
	launch int
	// An abort taken over before pi started the run: delivered on agent_start.
	pendingAbort bool
	held         []heldInput
	disposed     bool
	disposeID    string
	done         chan struct{}
	// pi's context fullness and pi-ai's overflow verdict, announced by the
	// host just before the event they belong to (processor goroutine only).
	pendingContext  *oar.ContextUsage
	pendingOverflow bool
}

func piImages(images []kernel.LoadedImage) []jsonx.Record {
	out := make([]jsonx.Record, 0, len(images))
	for _, image := range images {
		out = append(out, jsonx.Record{"type": "image", "data": image.Data, "mimeType": image.MediaType})
	}
	return out
}

// Session opens a pi session (piSession).
var Session = kernel.WithSessionCredentials(open)

func open(ctx context.Context, installation oar.AvailableInstallation, options oar.SessionOptions, credentials kernel.Credentials) (oar.Session, error) {
	installation, err := executableOf(ctx, installation)
	if err != nil {
		return nil, err
	}
	if err := shared.RefuseSessionOptions(RefusedSessionOptions, options); err != nil {
		return nil, err
	}
	if err := shared.CheckSessionName(options); err != nil {
		return nil, err
	}
	if err := validateMCPEnvironment(options); err != nil {
		return nil, err
	}
	if options.Effort != "" {
		if _, err := ThinkingLevel(options.Effort); err != nil {
			return nil, err
		}
	}
	if options.Model != "" {
		if _, _, err := SplitModelID(options.Model); err != nil {
			return nil, err
		}
	}
	job, err := openJob(options, AgentDir())
	if err != nil {
		return nil, err
	}
	process, client, err := startHost(installation, options.Cwd)
	if err != nil {
		return nil, err
	}
	openCtx, cancel := context.WithTimeout(ctx, openTimeout)
	defer cancel()
	data, err := client.request(openCtx, job)
	if err != nil {
		process.Kill()
		<-process.Exited()
		if errors.Is(err, errExited) {
			return nil, executable.ProcessFailure("pi exited while opening the session", process.Diagnostics())
		}
		return nil, openFailure(err, options.Resume)
	}
	opened := jsonx.ParseRecord(data)
	sessionID := jsonx.Str(opened, "sessionId")
	s := &session{
		kernel:  credentials.Kernel(sessionID),
		process: process,
		client:  client,
		caps:    oar.SessionCapabilities{Attribution: "none", Images: true},
		creds:   credentials,
		done:    make(chan struct{}),
	}
	if model := jsonx.Str(opened, "model"); model != "" {
		// The SDK's own report of the model and thinking level in effect at open.
		level := jsonx.Str(opened, "thinkingLevel")
		native := jsonx.Marshal(jsonx.Record{"sessionId": sessionID, "model": model, "thinkingLevel": level})
		s.kernel.Frame(oar.FrameBody{Type: "pi/session_opened", Native: native, Events: []oar.EventBody{oar.Model{Model: model}, oar.Effort{Effort: level}}}, kernel.RecordAt{})
	}
	go s.processEvents()
	return credentials.Seal(s), nil
}

// processEvents is the one goroutine that records pi's stdout, in order.
var mcpRefusal = regexp.MustCompile(`(MCP server "[^"]*" is already registered by extension "[^"]*")`)

func (s *session) processEvents() {
	for {
		item := s.client.take()
		if item.exit {
			s.mu.Lock()
			// An outcome only OAR observes: answers our dispose when we caused
			// the exit, stands alone (requestId "") when pi died on its own.
			s.kernel.Respond(s.disposeID, oar.ExitedBody(item.code), kernel.RecordAt{})
			s.running = false
			s.started = false
			s.mu.Unlock()
			close(s.done)
			return
		}
		native := json.RawMessage(item.line)
		event := jsonx.ParseRecord(native)
		if event == nil {
			s.mu.Lock()
			s.kernel.Frame(oar.FrameBody{Type: "pi/unreadable", Native: jsonx.Marshal(item.line)}, kernel.RecordAt{})
			s.mu.Unlock()
			continue
		}
		kind := jsonx.Str(event, "type")
		switch kind {
		case "oar_context":
			usage := jsonx.AsRecord(event["usage"])
			context := &oar.ContextUsage{Tokens: jsonx.Int64(usage, "tokens"), ContextWindow: jsonx.Int64(usage, "contextWindow")}
			if percent, ok := jsonx.Num(usage, "percent"); ok {
				context.Percent = &percent
			}
			s.pendingContext = context
			continue
		case "oar_overflow":
			s.pendingOverflow = true
			continue
		case "oar_credential":
			s.creds.Add(jsonx.Str(event, "key"))
			continue
		case "oar_prompt_rejected":
			s.promptRejected(jsonx.Str(event, "message"))
			continue
		case "oar_abort_rejected":
			s.mu.Lock()
			s.kernel.Frame(oar.FrameBody{Type: "pi/abort_rejected", Native: jsonx.Marshal(jsonx.Record{"message": jsonx.Str(event, "message")})}, kernel.RecordAt{})
			s.mu.Unlock()
			continue
		case "extension_ui_request":
			s.extensionRequest(native, event)
			continue
		}
		extra := FoldExtra{Overflow: s.pendingOverflow}
		s.pendingOverflow = false
		if kind == "agent_settled" {
			// pi is authoritative on context fullness, read at the run's end.
			extra.Context = s.pendingContext
			s.pendingContext = nil
		}
		s.mu.Lock()
		if kind == "agent_start" {
			s.running = true
			s.started = true
			if s.pendingAbort {
				s.pendingAbort = false
				go s.abortNative()
			}
		}
		var frame oar.FrameBody
		s.projection, frame = FoldEvent(s.projection, native, event, extra)
		s.kernel.Frame(frame, kernel.RecordAt{})
		for _, body := range frame.Events {
			if _, ended := body.(oar.TurnEnded); ended {
				s.running = false
				s.started = false
				s.drainHeld()
			}
		}
		s.mu.Unlock()
	}
}

// promptRejected: pi failed a started run without its own settlement. That
// failure is pi's own word, recorded as an event carrying pi's message; it
// ends the turn only when no agent_settled already did (session.ts).
func (s *session) promptRejected(message string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.running {
		return
	}
	s.running = false
	s.started = false
	s.kernel.Frame(oar.FrameBody{Type: "pi/prompt_rejected", Native: jsonx.Marshal(jsonx.Record{"message": message}),
		Events: []oar.EventBody{oar.TurnEnded{Outcome: oar.Failed(shared.ClassifyFailure(message), message)}}}, kernel.RecordAt{})
	s.drainHeld()
}

// extensionRequest records an extension's UI request. A dialog is a toApp
// request answered at once with a cancellation (no person sits at an
// embedded session; a dialog left open would hold the extension until its
// timeout); fire-and-forget methods are frames.
func (s *session) extensionRequest(native json.RawMessage, event jsonx.Record) {
	method := jsonx.Str(event, "method")
	id := jsonx.Str(event, "id")
	s.mu.Lock()
	defer s.mu.Unlock()
	switch method {
	case "select", "confirm", "input", "editor":
		s.kernel.Request(oar.ToApp, oar.RequestBody{Kind: oar.RequestNative, Type: method, Native: native}, kernel.RecordAt{ID: id})
		reply := jsonx.Record{"type": "extension_ui_response", "id": id, "cancelled": true}
		s.client.send(reply)
		s.kernel.Respond(id, oar.ResponseBody{Kind: oar.ResponseAnswered, Native: jsonx.Marshal(reply)}, kernel.RecordAt{})
	default:
		s.kernel.Frame(oar.FrameBody{Type: "extension_ui_request", Native: native}, kernel.RecordAt{})
	}
}

// abortNative asks pi to abort; a refusal is recorded from the host's own report.
func (s *session) abortNative() {
	_, _ = s.client.request(context.Background(), jsonx.Record{"type": "abort"})
}

// begin marks a run in progress for a prompt about to be sent; under s.mu.
func (s *session) begin() int {
	s.running = true
	s.started = false
	s.projection = Prompted(s.projection)
	s.launch++
	return s.launch
}

// send sends the prompt begin opened; called with s.mu held, released while
// pi answers. Accepted once pi takes the prompt; rejected with pi's words.
func (s *session) send(token int, input string, images []kernel.LoadedImage) oar.ResponseBody {
	command := jsonx.Record{"type": "prompt", "message": input}
	if len(images) > 0 {
		command["images"] = piImages(images)
	}
	s.mu.Unlock()
	data, err := s.client.request(context.Background(), command)
	s.mu.Lock()
	if err != nil {
		if s.launch == token && !s.started {
			s.running = false
		}
		return oar.Rejected(oar.CodeRuntimeRefused, err.Error())
	}
	if jsonx.Str(jsonx.ParseRecord(data), "disposition") == "handled" && s.launch == token && !s.started {
		// An extension command or input handler consumed it: no run started.
		s.running = false
	}
	return oar.Accepted()
}

// drainHeld sends the next held input once nothing runs; under s.mu.
func (s *session) drainHeld() {
	if s.disposed || s.running || len(s.held) == 0 {
		return
	}
	next := s.held[0]
	s.held = s.held[1:]
	token := s.begin()
	go func() {
		s.mu.Lock()
		defer s.mu.Unlock()
		decided := s.send(token, next.input, next.images)
		if decided.Kind == oar.ResponseRejected {
			// The queue took the input over; pi refusing it enters the stream.
			native := jsonx.Marshal(jsonx.Record{"message": decided.Reason, "input": next.input, "inputId": next.inputID})
			s.kernel.Frame(oar.FrameBody{Type: "pi/prompt_rejected", Native: native}, kernel.RecordAt{})
			s.drainHeld()
		}
	}()
}

func (s *session) ID() string                            { return s.kernel.SessionID() }
func (s *session) Capabilities() oar.SessionCapabilities { return s.caps }

func inputBody(kind oar.RequestKind, input string, options oar.InputOptions) oar.RequestBody {
	return oar.RequestBody{Kind: kind, Input: input, InputID: options.InputID, Images: options.Images, Origin: options.Origin}
}

func (s *session) Prompt(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kernel.Control(inputBody(oar.RequestPrompt, input, options), func(oar.RawEvent) (oar.ResponseBody, error) {
		if s.running {
			return oar.Rejected(oar.CodeBusy, "busy"), nil
		}
		return kernel.WithInputImages(s.caps.Images, options.Images, func(images []kernel.LoadedImage) (oar.ResponseBody, error) {
			return s.send(s.begin(), input, images), nil
		})
	}, kernel.RecordAt{}), nil
}

func (s *session) Steer(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kernel.Control(inputBody(oar.RequestSteer, input, options), func(oar.RawEvent) (oar.ResponseBody, error) {
		if !s.running {
			return oar.Rejected(oar.CodeNoActiveTurn, "not_steerable: no active turn"), nil
		}
		return kernel.WithInputImages(s.caps.Images, options.Images, func(images []kernel.LoadedImage) (oar.ResponseBody, error) {
			command := jsonx.Record{"type": "steer", "message": input}
			if len(images) > 0 {
				command["images"] = piImages(images)
			}
			s.mu.Unlock()
			_, err := s.client.request(context.Background(), command)
			s.mu.Lock()
			if err != nil {
				return oar.ResponseBody{}, err
			}
			return oar.Accepted(), nil
		})
	}, kernel.RecordAt{}), nil
}

func (s *session) Queue(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kernel.Control(inputBody(oar.RequestQueue, input, options), func(oar.RawEvent) (oar.ResponseBody, error) {
		return kernel.WithInputImages(s.caps.Images, options.Images, func(images []kernel.LoadedImage) (oar.ResponseBody, error) {
			s.held = append(s.held, heldInput{input: input, inputID: options.InputID, images: images})
			s.drainHeld()
			return oar.Accepted(), nil
		})
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
		if !s.running {
			return oar.Rejected(oar.CodeNoActiveTurn, "no active turn"), nil
		}
		// Before agent_start, hold the intent until pi has started the run.
		if s.started {
			go s.abortNative()
		} else {
			s.pendingAbort = true
		}
		return oar.Accepted(), nil
	}, kernel.RecordAt{}), nil
}

func (s *session) RawEvents(observer oar.RawEventObserver, cursor *oar.Cursor) oar.Unsubscribe {
	return s.kernel.RawEvents(observer, cursor)
}

func (s *session) Records() []oar.RawEvent { return s.kernel.Records() }
func (s *session) Graph() oar.SessionGraph { return s.kernel.Graph() }

func (s *session) Resources(context.Context) (*oar.SessionResources, error) {
	resources := s.process.Resources()
	if resources == nil {
		return nil, nil
	}
	return &oar.SessionResources{RSS: resources.RSS, Processes: resources.Processes}, nil
}

// Dispose records the dispose request, aborts a running turn, asks pi for
// an orderly shutdown (stdin closed), and stops its process tree when it
// does not exit within the grace; the exit response answers the request.
func (s *session) Dispose(ctx context.Context) error {
	s.mu.Lock()
	if s.disposed {
		s.mu.Unlock()
		<-s.done
		return nil
	}
	s.disposed = true
	s.held = nil
	gone := s.kernel.Unreachable() != nil
	request := s.kernel.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestDispose}, kernel.RecordAt{})
	if gone {
		// The exit is already recorded; nothing is left to release.
		s.kernel.Respond(request.ID, oar.Accepted(), kernel.RecordAt{})
		s.mu.Unlock()
		return nil
	}
	s.disposeID = request.ID
	s.mu.Unlock()
	// The host aborts a running turn (pi's own agent_settled ends it in the
	// stream), shuts the extensions down within their deadline and exits.
	disposeCtx, cancel := context.WithTimeout(ctx, disposeTimeout+5*time.Second)
	_, _ = s.client.request(disposeCtx, jsonx.Record{"type": "dispose"})
	cancel()
	s.process.CloseStdin()
	select {
	case <-s.done:
	case <-time.After(5 * time.Second):
		s.process.Kill()
		<-s.done
	case <-ctx.Done():
		s.process.Kill()
		<-s.done
	}
	return nil
}
