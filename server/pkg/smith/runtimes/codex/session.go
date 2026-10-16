package codex

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"sync"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/internal/shared"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// The codex session adapter (session.ts). App-server v2: RPC replies answer
// controls; notifications carry facts. Replies are recorded as their line is
// read, before later notifications. Model/effort read-back and resume
// overrides live in open.go. Reachability comes from the recorded
// exit/dispose, never a separate liveness flag. Native mappings and live
// evidence: docs/runtimes/codex.md.
//
// Concurrency (PORTING.md): one lock, s.mu, guards all adapter state. The
// notification, server-request, reply (onSettled) and exit handlers run on
// the app-server's line goroutine and take s.mu; the abort fallback's timer
// takes it too. It is released around every RPC wait.

// abortFallbackTimeout bounds an interrupt codex does not end; a var so tests can shorten it.
var abortFallbackTimeout = shared.DefaultAbortFallbackTimeout

var codexCapabilities = oar.SessionCapabilities{QueueDurable: true, Attribution: "nested", Images: true}

type codexSession struct {
	mu       sync.Mutex
	k        *kernel.Kernel
	client   appServerClient
	threadID string
	options  oar.SessionOptions

	// The prompt request whose turn is running; nil while idle or during a spontaneous turn.
	active *oar.RawEvent
	// True while codex runs a root turn we did not prompt (a drained queue submission).
	spontaneous bool
	// The runtime's id for the active root turn; steer/abort identity.
	codexTurnID    string
	projection     codexProjectionState
	abortFallback  *shared.AbortFallback
	disposeRequest *oar.RawEvent
	// Records the open event; set once the kernel exists.
	recordOpen func()
}

// Session opens a codex session (codexSession).
var Session oar.StartSession = kernel.WithSessionCredentials(openCodexSession)

var initializeParams = jsonx.Record{
	"clientInfo":   jsonx.Record{"name": "oar", "version": "0.0.0"},
	"capabilities": jsonx.Record{"experimentalApi": true},
}

func openCodexSession(ctx context.Context, installation oar.AvailableInstallation, options oar.SessionOptions, credentials kernel.Credentials) (oar.Session, error) {
	if installation.Via != "executable" {
		return nil, errors.New("The codex session adapter needs an executable installation")
	}
	// Threads persist so a later SessionOptions.Resume can reattach; the
	// thread id is the runtime-native identity and becomes Session.ID (open.go
	// builds the request, and refuses what it cannot build before anything starts).
	open, err := codexThreadOpen(options)
	if err != nil {
		return nil, err
	}
	// YOLO default (repo policy 2026-08-24): bypass the sandbox too, not just
	// approvals; OAR_CODEX_SANDBOX pins a stricter mode when a host wants one.
	// Injected as a launch -c override (app_server_client.go). A host that
	// wants the user's own config to win can set OAR_CODEX_SANDBOX=inherit to
	// skip the override entirely.
	sandboxMode, set := os.LookupEnv("OAR_CODEX_SANDBOX")
	if !set {
		sandboxMode = "danger-full-access"
	}
	var overrides []configOverride
	if sandboxMode != "inherit" {
		overrides = []configOverride{{key: "sandbox_mode", value: `"` + sandboxMode + `"`}}
	}
	// Every error the client reports goes through the redactor first: the
	// open's config carries the session's MCP credentials to codex.
	client := startAppServerClient(installation.Command, options.Env, overrides, "", appServerProcessOptions{redact: open.Redact, launchArgs: options.LaunchArgs})
	s := &codexSession{client: client, options: options}
	if _, err := client.request(ctx, "initialize", initializeParams, nil); err != nil {
		// TS leaves a non-initializing app-server running here until the host
		// exits; Go has no exit hook (smith/GAPS.md), so it is stopped.
		client.kill()
		return nil, err
	}
	client.notify("initialized", jsonx.Record{})
	params, err := prepareCodexToolDenials(ctx, client, options, open.Params)
	if err != nil {
		return nil, err
	}
	// The open event is marked at the reply's wire position AS the reply line
	// is read (onSettled → client.mark), not after this call returns: a frame
	// codex wrote in the same chunk right after the reply (thread/started)
	// would otherwise precede it. The mark runs when the handlers register
	// below, once the kernel exists; a failed open registers none, so it
	// never runs.
	markOpen := func(outcome rpcOutcome) {
		if outcome.kind == "result" {
			client.mark(func() {
				s.mu.Lock()
				defer s.mu.Unlock()
				if s.recordOpen != nil {
					s.recordOpen()
				}
			})
		}
	}
	started, err := openThread(client, open.Method, func() (rpcResult, error) {
		return client.request(ctx, open.Method, params, markOpen)
	}, options.ServiceTier, options.Resume, open.Redact)
	if err != nil {
		return nil, err
	}
	threadID, ok := jsonx.AsRecord(started.record["thread"])["id"].(string)
	if !ok {
		client.kill()
		return nil, errors.New("codex thread start/resume returned no thread id")
	}
	// The reply is codex's word on the model and effort the thread runs (the
	// open frame's events); anything but what was requested refuses the open.
	events, refusal, resumeEffort := codexOpenReadback(open.Method, options, started.record)
	if refusal != "" {
		client.kill()
		<-client.exited()
		return nil, errors.New(refusal)
	}
	s.mu.Lock()
	s.k = credentials.Kernel(threadID)
	s.threadID = threadID
	// A resume awaits codex's re-report of the thread's total so far: the
	// baseline this Session's token totals count from (projection.go, #169).
	s.projection = initialCodexProjection(threadID, open.Method)
	s.abortFallback = shared.NewAbortFallback(client.kill, abortFallbackTimeout, &s.mu)
	s.recordOpen = func() {
		s.k.Frame(oar.FrameBody{Type: open.Method, Native: started.raw, Events: events}, kernel.RecordAt{})
	}
	s.mu.Unlock()
	// Registering flushes everything held so far in wire order: the frames
	// from before the thread existed, then the open event (the mark placed at
	// the reply), then whatever codex wrote after the reply.
	if err := client.handle(appServerHandlers{onNotification: s.onNotification, onServerRequest: s.onServerRequest}); err != nil {
		client.kill()
		return nil, err
	}
	client.onExit(s.onExit)
	if resumeEffort != "" {
		if refusal := s.setResumeEffort(ctx, resumeEffort); refusal != "" {
			client.kill()
			<-client.exited()
			return nil, errors.New(refusal)
		}
	}
	// Last, so an open refused above leaves the user's thread unrenamed.
	if err := nameThread(ctx, client, threadID, codexThreadName(open.Method, options, started.record)); err != nil {
		return nil, err
	}
	return credentials.Seal(s), nil
}

// setResumeEffort sets the level the resumed thread runs on the loaded
// thread and takes codex's pushed settings (a recorded frame) as the word on
// it: why it does not run requested, or "".
func (s *codexSession) setResumeEffort(ctx context.Context, requested string) string {
	s.mu.Lock()
	from := s.k.Len()
	s.mu.Unlock()
	// The report's deadline starts before the update is sent, as in TS.
	reported, cancel := context.WithTimeout(ctx, settingsReportTimeout)
	defer cancel()
	var updateError *string
	var settings jsonx.Record
	if _, err := s.client.request(ctx, "thread/settings/update", jsonx.Record{"threadId": s.threadID, "effort": requested}, nil); err != nil {
		message := err.Error()
		updateError = &message
	} else if record, err := s.k.WaitFor(reported, from, func(record oar.RawEvent) bool {
		return record.Kind == oar.KindFrame && record.Frame.Type == "thread/settings/updated" && record.SessionID == s.threadID
	}); err == nil {
		settings = jsonx.ParseRecord(record.Frame.Native)
	}
	return codexResumeEffortRefusal(requested, updateError, settings)
}

func (s *codexSession) busy() bool { return s.active != nil || s.spontaneous }

// onNotification drives the pure projection fold, applying its commands to
// the kernel; the fold owns event translation, attribution and graph links;
// this owns the transport-only turn id and the control decisions (busy, spontaneous).
func (s *codexSession) onNotification(method string, params json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	threadID, isString := jsonx.ParseRecord(params)["threadId"].(string)
	isRoot := !isString || threadID == s.threadID
	if isRoot && method == "turn/started" {
		if !s.busy() {
			// A turn we did not prompt (a drained queue submission): adopt it.
			s.spontaneous = true
		}
		if turnID, ok := jsonx.AsRecord(jsonx.ParseRecord(params)["turn"])["id"].(string); ok {
			s.codexTurnID = turnID
		}
	}
	next, commands := foldCodexNotification(s.projection, method, params)
	s.projection = next
	var edges []oar.SessionEdge
	for _, command := range commands {
		if command.Kind == "link" {
			edges = append(edges, command.Edge)
		}
	}
	links := shared.NewSessionLinks(s.k, edges)
	for _, command := range commands {
		if command.Kind != "frame" {
			continue
		}
		body := command.Body
		events := append([]oar.EventBody{}, body.Events...)
		for _, link := range links {
			events = append(events, link)
		}
		body.Events = events
		s.k.Frame(body, kernel.RecordAt{SessionID: command.SessionID, SpanID: command.SpanID})
	}
	if isRoot && method == "turn/completed" {
		s.abortFallback.Clear()
		s.active = nil
		s.spontaneous = false
		s.codexTurnID = ""
	}
}

// onServerRequest records approvals, user input and dynamic tools verbatim,
// never answered (approvalPolicy never means none are expected; a dangling
// request is the honest record when one arrives anyway).
func (s *codexSession) onServerRequest(id, method string, params json.RawMessage) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.k.Request(oar.ToApp, oar.RequestBody{Kind: oar.RequestNative, Type: method, Native: params}, kernel.RecordAt{ID: id})
}

// onExit: the exit is an outcome only oar observes. It answers our dispose
// when we caused it, and stands alone when the app-server died on its own.
func (s *codexSession) onExit(code *int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.abortFallback.Clear()
	requestID := ""
	if s.disposeRequest != nil {
		requestID = s.disposeRequest.ID
	}
	s.k.Respond(requestID, oar.ExitedBody(code), kernel.RecordAt{})
	s.active = nil
	s.spontaneous = false
	s.codexTurnID = ""
}

func (s *codexSession) ID() string                            { return s.k.SessionID() }
func (s *codexSession) Capabilities() oar.SessionCapabilities { return codexCapabilities }

func inputBody(kind oar.RequestKind, input string, options oar.InputOptions) oar.RequestBody {
	return oar.RequestBody{Kind: kind, Input: input, InputID: options.InputID, Images: options.Images, Origin: options.Origin}
}

func accepted(reply rpcResult) oar.ResponseBody {
	return oar.ResponseBody{Kind: oar.ResponseAccepted, Native: reply.raw}
}

func refusedBy(code oar.RejectionCode) func(string) oar.ResponseBody {
	return func(message string) oar.ResponseBody { return oar.Rejected(code, message) }
}

func (s *codexSession) Prompt(ctx context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	return s.rpcControl(ctx, func() rpcControlPlan {
		params := jsonx.Record{"threadId": s.threadID, "input": codexUserInput(input, options.Images)}
		if options.InputID != "" {
			params["clientUserMessageId"] = options.InputID
		}
		if len(s.options.OutputSchema) > 0 {
			params["outputSchema"] = s.options.OutputSchema
		}
		return rpcControlPlan{
			body: inputBody(oar.RequestPrompt, input, options),
			gate: func(request oar.RawEvent) *oar.ResponseBody {
				if s.busy() {
					return rejected(oar.CodeBusy, "busy")
				}
				if refused := kernel.InputImagesRefusal(codexCapabilities.Images, options.Images); refused != nil {
					return refused
				}
				// Hold the slot while the RPC is in flight so a concurrent prompt is busy.
				s.active = &request
				return nil
			},
			method: "turn/start",
			params: func() any { return params },
			onReply: func(reply rpcResult) oar.ResponseBody {
				turnID, ok := jsonx.AsRecord(reply.record["turn"])["id"].(string)
				if !ok {
					s.active = nil
					return oar.ResponseBody{Kind: oar.ResponseRejected, Code: oar.CodeRuntimeRefused, Reason: "codex turn/start returned no turn id", Native: reply.raw}
				}
				s.codexTurnID = turnID
				return accepted(reply)
			},
			onError: func(message string) oar.ResponseBody {
				s.active = nil
				return oar.Rejected(oar.CodeRuntimeRefused, message)
			},
		}
	})
}

func (s *codexSession) Steer(ctx context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	return s.rpcControl(ctx, func() rpcControlPlan {
		expectedTurnID := s.codexTurnID
		params := jsonx.Record{"threadId": s.threadID, "input": codexUserInput(input, options.Images), "expectedTurnId": optionalTurnID(expectedTurnID)}
		if options.InputID != "" {
			params["clientUserMessageId"] = options.InputID
		}
		return rpcControlPlan{
			body: inputBody(oar.RequestSteer, input, options),
			gate: func(oar.RawEvent) *oar.ResponseBody {
				if !s.busy() || expectedTurnID == "" {
					return rejected(oar.CodeNoActiveTurn, "not_steerable: no active turn")
				}
				return kernel.InputImagesRefusal(codexCapabilities.Images, options.Images)
			},
			method: "turn/steer",
			params: func() any { return params },
			onReply: func(reply rpcResult) oar.ResponseBody {
				if expectedTurnID != "" && options.InputID != "" {
					s.projection.Inputs = acceptCodexSteer(s.projection.Inputs, expectedTurnID, options.InputID)
				}
				return accepted(reply)
			},
			onError: func(message string) oar.ResponseBody {
				return oar.Rejected(oar.CodeRuntimeRefused, "not_steerable: "+message)
			},
		}
	})
}

func optionalTurnID(turnID string) any {
	if turnID == "" {
		return nil
	}
	return turnID
}

// Queue adds input to codex's own queue; the reply carries the runtime's
// submission id, retained on the response.
func (s *codexSession) Queue(ctx context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	return s.rpcControl(ctx, func() rpcControlPlan {
		clientID := options.InputID
		if clientID == "" {
			clientID = observe.NewUUID()
		}
		return rpcControlPlan{
			body: inputBody(oar.RequestQueue, input, options),
			gate: func(oar.RawEvent) *oar.ResponseBody {
				if len(s.options.OutputSchema) > 0 {
					return rejected(oar.CodeUnsupported, "codex queued input cannot carry outputSchema; use prompt after the current turn ends")
				}
				return kernel.InputImagesRefusal(codexCapabilities.Images, options.Images)
			},
			method: "thread/queue/add",
			params: func() any {
				return jsonx.Record{"threadId": s.threadID, "input": codexUserInput(input, options.Images), "clientUserMessageId": clientID}
			},
			onReply: accepted,
			onError: refusedBy(oar.CodeRuntimeRefused),
		}
	})
}

// No Withdraw: the queue is codex's own, and thread/queue/delete is
// experimental and not live-verified (docs/runtimes/input-cancellation.md).

// Abort interrupts the active turn. An early or late interrupt can be
// refused; turn/completed is the outcome.
func (s *codexSession) Abort(ctx context.Context) (oar.ControlResult, error) {
	return s.rpcControl(ctx, func() rpcControlPlan {
		refuse := func() {}
		return rpcControlPlan{
			body: oar.RequestBody{Kind: oar.RequestAbort},
			gate: func(oar.RawEvent) *oar.ResponseBody {
				if !s.busy() || s.codexTurnID == "" {
					return rejected(oar.CodeNoActiveTurn, "no active turn")
				}
				return nil
			},
			onPending: func(accept func()) { refuse = s.abortFallback.Arm(accept) },
			method:    "turn/interrupt",
			params:    func() any { return jsonx.Record{"threadId": s.threadID, "turnId": s.codexTurnID} },
			onReply:   accepted,
			onError: func(message string) oar.ResponseBody {
				refuse()
				return oar.Rejected(oar.CodeRuntimeRefused, message)
			},
		}
	})
}

func (s *codexSession) RawEvents(observer oar.RawEventObserver, cursor *oar.Cursor) oar.Unsubscribe {
	return s.k.RawEvents(observer, cursor)
}

func (s *codexSession) Records() []oar.RawEvent { return s.k.Records() }
func (s *codexSession) Graph() oar.SessionGraph { return s.k.Graph() }

func (s *codexSession) Resources(context.Context) (*oar.SessionResources, error) {
	resources := s.client.resources()
	if resources == nil {
		return nil, nil
	}
	return &oar.SessionResources{RSS: resources.RSS, Processes: resources.Processes}, nil
}

// Dispose records the dispose, kills the app-server and waits for its exit,
// whose response onExit records: the process may hold state (codex's sqlite
// runtime in CODEX_HOME) that the next session needs released. It always
// settles, whatever ctx says.
func (s *codexSession) Dispose(context.Context) error {
	s.mu.Lock()
	if s.disposeRequest != nil {
		s.mu.Unlock()
		return nil
	}
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
	s.client.kill()
	<-s.client.exited()
	return nil
}
