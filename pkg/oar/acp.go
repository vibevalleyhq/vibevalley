package oar

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
)

// ACPProfile parameterizes a stdio ACP JSON-RPC 2.0 coding-agent runtime.
type ACPProfile struct {
	ID            string
	Command       string
	Args          []string
	SupportsSteer bool
	Refused       RefusedOptions
}

// OpenCodeProfile returns the ACP profile for opencode (`opencode acp`).
func OpenCodeProfile() ACPProfile {
	return ACPProfile{
		ID:            "opencode",
		Command:       "opencode",
		Args:          []string{"acp"},
		SupportsSteer: true,
		Refused: RefusedOptions{
			OptionDisallowedTools:       "opencode ACP has no per-session tool blocklist",
			OptionAllowedTools:          "opencode ACP has no per-session tool allowlist",
			OptionAdditionalDirectories: "opencode ACP does not accept additionalDirectories",
			OptionOutputSchema:          "opencode ACP has no outputSchema option",
			OptionName:                  "opencode ACP has no session display name option",
			OptionServiceTier:           "opencode ACP has no serviceTier option",
			OptionLaunchArgs:            "opencode driver does not accept raw launchArgs",
		},
	}
}

// GrokProfile returns the ACP profile for xAI Grok (`grok agent stdio`).
func GrokProfile() ACPProfile {
	return ACPProfile{
		ID:            "grok",
		Command:       "grok",
		Args:          []string{"agent", "stdio"},
		SupportsSteer: true,
		Refused: RefusedOptions{
			OptionDisallowedTools:       "grok agent stdio does not pass a tool blocklist on",
			OptionAllowedTools:          "grok agent stdio has no tool allowlist",
			OptionAdditionalDirectories: "grok agent stdio does not accept additionalDirectories",
			OptionOutputSchema:          "grok agent stdio has no outputSchema option",
			OptionName:                  "grok agent stdio has no session display name option",
			OptionServiceTier:           "grok agent stdio has no serviceTier option",
			OptionLaunchArgs:            "grok driver does not accept raw launchArgs",
		},
	}
}

// KimiProfile returns the ACP profile for Moonshot Kimi (`kimi acp`).
func KimiProfile() ACPProfile {
	return ACPProfile{
		ID:            "kimi",
		Command:       "kimi",
		Args:          []string{"acp"},
		SupportsSteer: false,
		Refused: RefusedOptions{
			OptionSystemPrompt:          "kimi acp has no per-session system prompt input",
			OptionAppendSystemPrompt:    "kimi acp has no per-session system prompt append",
			OptionDisallowedTools:       "kimi ACP has no per-session tool blocklist",
			OptionAllowedTools:          "kimi ACP has no per-session tool allowlist",
			OptionAdditionalDirectories: "kimi ACP does not accept additionalDirectories",
			OptionOutputSchema:          "kimi ACP has no outputSchema option",
			OptionName:                  "kimi ACP has no session display name option",
			OptionServiceTier:           "kimi ACP has no serviceTier option",
			OptionLaunchArgs:            "kimi driver does not accept raw launchArgs",
		},
	}
}

// CodeBuddyProfile returns the ACP profile for CodeBuddy Code (`codebuddy --acp`).
func CodeBuddyProfile() ACPProfile {
	return ACPProfile{
		ID:            "codebuddy",
		Command:       "codebuddy",
		Args:          []string{"--acp"},
		SupportsSteer: false,
		Refused: RefusedOptions{
			OptionSystemPrompt:          "codebuddy --acp has no per-session system prompt input",
			OptionAppendSystemPrompt:    "codebuddy --acp has no per-session system prompt append",
			OptionDisallowedTools:       "codebuddy --acp has no per-session tool blocklist",
			OptionAllowedTools:          "codebuddy --acp has no per-session tool allowlist",
			OptionAdditionalDirectories: "codebuddy --acp does not accept additionalDirectories",
			OptionOutputSchema:          "codebuddy --acp has no outputSchema option",
			OptionName:                  "codebuddy --acp has no session display name option",
			OptionServiceTier:           "codebuddy --acp has no serviceTier option",
			OptionLaunchArgs:            "codebuddy driver does not accept raw launchArgs",
		},
	}
}

// ACPDriver drives any ACP-compliant coding agent CLI over stdio JSON-RPC 2.0.
type ACPDriver struct {
	profile ACPProfile
}

// NewACPDriver builds an ACP driver from a runtime profile.
func NewACPDriver(profile ACPProfile) ACPDriver {
	return ACPDriver{profile: profile}
}

// ID returns the configured profile runtime ID.
func (d ACPDriver) ID() string { return d.profile.ID }

// RefusedOptions returns a copy of the profile's statically refused options.
func (d ACPDriver) RefusedOptions() RefusedOptions {
	out := make(RefusedOptions, len(d.profile.Refused))
	for k, v := range d.profile.Refused {
		out[k] = v
	}
	return out
}

// Open validates options pre-spawn, launches the ACP binary, negotiates initialize/session open,
// and applies model and effort config options.
func (d ACPDriver) Open(ctx context.Context, opts SessionOptions) (Session, error) {
	if err := ValidateOptions(d.ID(), d.RefusedOptions(), opts); err != nil {
		return nil, err
	}

	cmd := opts.BinPath
	if cmd == "" {
		cmd = d.profile.Command
	}
	spec := LaunchSpec{
		Command: cmd,
		Args:    slices.Clone(d.profile.Args),
		Dir:     opts.CWD,
		Env:     buildEnv(opts, nil),
	}

	proc, err := opts.launcher().Launch(ctx, spec)
	if err != nil {
		return nil, err
	}

	initialID := opts.ResumeSessionID
	if initialID == "" {
		initialID = fmt.Sprintf("%s-pending", d.profile.ID)
	}

	s := &acpSession{
		profile:    d.profile,
		opts:       opts,
		proc:       proc,
		stream:     newRecordStream(initialID, opts.nowMillis),
		resumed:    opts.ResumeSessionID != "",
		childPaths: make(map[string][]string),
		doneCh:     make(chan struct{}),
		stopTurnCh: make(chan struct{}),
	}
	s.peer = newRPCPeer(proc.Stdin(), s.onNotification, s.onServerRequest, s.onEOF)

	go s.drainStderr()
	go s.runReader()

	if err := s.handshake(ctx); err != nil {
		_ = s.Dispose(context.Background())
		return nil, err
	}

	return s, nil
}

type acpSession struct {
	profile ACPProfile
	opts    SessionOptions
	proc    Process
	peer    *rpcPeer
	stream  *recordStream
	queue   inputQueue

	nextSpanSeq atomic.Int64
	turnWG      sync.WaitGroup
	drainWG     sync.WaitGroup
	stopTurnCh  chan struct{}

	mu           sync.Mutex
	rootID       string
	supportsClos bool
	effortCfgID  string
	activeTurn   bool
	activeSpanID string
	exited       bool
	disposed     bool
	resumed      bool
	usage        *TokenTotals
	childPaths   map[string][]string

	doneCh      chan struct{}
	waitErr     error
	disposeOnce sync.Once
	disposeErr  error
}

func (s *acpSession) handshake(ctx context.Context) error {
	reqCtx, cancel := context.WithTimeout(ctx, s.opts.requestTimeout())
	defer cancel()

	initResRaw, err := s.peer.call(reqCtx, "initialize", map[string]any{
		"protocolVersion": 1,
		"clientCapabilities": map[string]any{
			"fs": map[string]any{
				"readTextFile":  false,
				"writeTextFile": false,
			},
			"terminal": false,
		},
	})
	if err != nil {
		return fmt.Errorf("oar: %s initialize: %w", s.profile.ID, err)
	}

	var initRes struct {
		AgentCapabilities struct {
			LoadSession         bool `json:"loadSession"`
			SessionCapabilities struct {
				Close  json.RawMessage `json:"close"`
				Resume json.RawMessage `json:"resume"`
				Load   json.RawMessage `json:"load"`
			} `json:"sessionCapabilities"`
		} `json:"agentCapabilities"`
	}
	_ = json.Unmarshal(initResRaw, &initRes)

	supportsResume := len(initRes.AgentCapabilities.SessionCapabilities.Resume) > 0 && string(initRes.AgentCapabilities.SessionCapabilities.Resume) != "null"
	supportsLoad := initRes.AgentCapabilities.LoadSession || (len(initRes.AgentCapabilities.SessionCapabilities.Load) > 0 && string(initRes.AgentCapabilities.SessionCapabilities.Load) != "null")
	supportsClose := len(initRes.AgentCapabilities.SessionCapabilities.Close) > 0 && string(initRes.AgentCapabilities.SessionCapabilities.Close) != "null"

	cwd := s.opts.CWD
	if cwd == "" {
		cwd = "."
	}
	openParams := map[string]any{
		"cwd":        cwd,
		"mcpServers": acpMCPServers(s.opts.MCPServers),
	}
	if s.opts.SystemPrompt != "" || s.opts.AppendSystemPrompt != "" {
		meta := map[string]any{}
		if s.opts.SystemPrompt != "" {
			meta["systemPrompt"] = s.opts.SystemPrompt
		}
		if s.opts.AppendSystemPrompt != "" {
			meta["appendSystemPrompt"] = s.opts.AppendSystemPrompt
		}
		openParams["_meta"] = meta
	}

	var openResRaw json.RawMessage
	if s.resumed {
		openParams["sessionId"] = s.opts.ResumeSessionID
		method := "session/resume"
		if !supportsResume && supportsLoad {
			method = "session/load"
		}
		openResRaw, err = s.peer.call(reqCtx, method, openParams)
		if err != nil && method == "session/resume" {
			var rerr *rpcError
			if errors.As(err, &rerr) && rerr.Code == -32601 {
				openResRaw, err = s.peer.call(reqCtx, "session/load", openParams)
			}
		}
		if err != nil {
			return fmt.Errorf("oar: %s resume: %w", s.profile.ID, err)
		}
	} else {
		openResRaw, err = s.peer.call(reqCtx, "session/new", openParams)
		if err != nil {
			return fmt.Errorf("oar: %s session/new: %w", s.profile.ID, err)
		}
	}

	var openRes struct {
		SessionID     string `json:"sessionId"`
		ConfigOptions []struct {
			ID       string `json:"id"`
			Category string `json:"category"`
		} `json:"configOptions"`
	}
	_ = json.Unmarshal(openResRaw, &openRes)

	sessionID := openRes.SessionID
	if sessionID == "" {
		sessionID = s.opts.ResumeSessionID
	}
	if sessionID == "" {
		return fmt.Errorf("oar: %s returned empty sessionId", s.profile.ID)
	}

	effortCfgID := "reasoning_effort"
	for _, cfg := range openRes.ConfigOptions {
		if cfg.Category == "thought_level" && cfg.ID != "" {
			effortCfgID = cfg.ID
			break
		}
	}

	s.stream.setSessionID(sessionID)
	s.mu.Lock()
	s.rootID = sessionID
	s.supportsClos = supportsClose
	s.effortCfgID = effortCfgID
	s.childPaths[sessionID] = []string{}
	s.mu.Unlock()

	if s.opts.Model != "" {
		_, err := s.peer.call(reqCtx, "session/set_config_option", map[string]any{
			"sessionId": sessionID,
			"configId":  "model",
			"value":     s.opts.Model,
		})
		if err != nil {
			var rerr *rpcError
			if errors.As(err, &rerr) && rerr.Code == -32601 {
				_, err = s.peer.call(reqCtx, "session/set_model", map[string]any{
					"sessionId": sessionID,
					"modelId":   s.opts.Model,
				})
			}
			if err != nil {
				return fmt.Errorf("oar: %s set model: %w", s.profile.ID, err)
			}
		}
		s.stream.emit(RecordFrame, "", []string{}, "session/model", nil, []Event{{Kind: EventModel, Model: s.opts.Model}}, nil, nil)
	}

	if s.opts.Effort != "" {
		if _, err := s.peer.call(reqCtx, "session/set_config_option", map[string]any{
			"sessionId": sessionID,
			"configId":  effortCfgID,
			"value":     s.opts.Effort,
		}); err != nil {
			return fmt.Errorf("oar: %s set effort: %w", s.profile.ID, err)
		}
		s.stream.emit(RecordFrame, "", []string{}, "session/effort", nil, []Event{{Kind: EventEffort, Effort: s.opts.Effort}}, nil, nil)
	}

	return nil
}

func acpMCPServers(servers []MCPServer) []map[string]any {
	out := make([]map[string]any, 0, len(servers))
	for _, s := range servers {
		if s.Type == MCPHTTP {
			headers := make([]map[string]string, 0, len(s.Headers))
			for k, v := range s.Headers {
				headers = append(headers, map[string]string{"name": k, "value": v})
			}
			out = append(out, map[string]any{
				"type":    "http",
				"name":    s.Name,
				"url":     s.URL,
				"headers": headers,
			})
			continue
		}
		args := s.Args
		if args == nil {
			args = []string{}
		}
		env := make([]map[string]string, 0, len(s.Env))
		for k, v := range s.Env {
			env = append(env, map[string]string{"name": k, "value": v})
		}
		out = append(out, map[string]any{
			"name":    s.Name,
			"command": s.Command,
			"args":    args,
			"env":     env,
		})
	}
	return out
}

func (s *acpSession) ID() string      { return s.stream.sessionIDSnapshot() }
func (s *acpSession) Runtime() string { return s.profile.ID }

func (s *acpSession) Records() []RecordEnvelope {
	return s.stream.recordsSnapshot()
}

func (s *acpSession) Subscribe(afterSeq int64, fn func(RecordEnvelope)) func() {
	return s.stream.subscribe(afterSeq, fn)
}

func (s *acpSession) Usage() *TokenTotals {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.usage.Clone()
}

func (s *acpSession) Wait(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.doneCh:
		return s.waitErr
	}
}

func (s *acpSession) Dispose(ctx context.Context) error {
	s.disposeOnce.Do(func() {
		s.mu.Lock()
		s.disposed = true
		closeCap := s.supportsClos
		rootID := s.rootID
		s.mu.Unlock()

		s.queue.clear()
		if closeCap && rootID != "" {
			closeCtx, cancel := context.WithTimeout(context.Background(), min(s.opts.requestTimeout(), defaultBaselineTimeout))
			_, _ = s.peer.call(closeCtx, "session/close", map[string]any{"sessionId": rootID})
			cancel()
		}
		close(s.stopTurnCh)
		_ = s.proc.Close()
		<-s.doneCh
		s.turnWG.Wait()
		s.drainWG.Wait()
		s.stream.closeSubscribers()
	})
	return s.disposeErr
}

func (s *acpSession) Control(ctx context.Context, action ControlAction, arg string, opts ...InputOption) (ControlOutcome, error) {
	return dispatchControl(ctx, s, action, arg, opts...)
}

func (s *acpSession) Prompt(ctx context.Context, input string, opts ...InputOption) (ControlOutcome, error) {
	if err := ctx.Err(); err != nil {
		return ControlOutcome{}, err
	}
	inOpts := resolveInputOptions(opts)

	s.mu.Lock()
	if s.exited || s.disposed {
		s.mu.Unlock()
		out := controlNotRunning(ControlPrompt, "session exited")
		controlOutcomeRecord(s.stream, ControlPrompt, inOpts.InputID, "", out)
		return out, nil
	}
	if s.activeTurn {
		s.mu.Unlock()
		out := ControlOutcome{
			Action:  ControlPrompt,
			Status:  ControlRejected,
			Code:    "busy",
			Reason:  "a turn is already active",
			InputID: inOpts.InputID,
		}
		controlOutcomeRecord(s.stream, ControlPrompt, inOpts.InputID, "", out)
		return out, nil
	}
	rootID := s.rootID
	spanID := inOpts.SpanID
	if spanID == "" {
		spanID = fmt.Sprintf("acp-turn-%d", s.nextSpanSeq.Add(1))
	}
	s.activeTurn = true
	s.activeSpanID = spanID
	s.mu.Unlock()

	s.stream.emit(RecordFrame, spanID, []string{}, "session/prompt", nil, []Event{{Kind: EventTurnStarted, Input: input, RequestID: inOpts.InputID}}, nil, nil)

	rpcKey, resCh, err := s.peer.sendAsync("session/prompt", map[string]any{
		"sessionId": rootID,
		"prompt":    []map[string]any{{"type": "text", "text": input}},
	})
	if err != nil {
		s.mu.Lock()
		s.activeTurn = false
		s.activeSpanID = ""
		s.mu.Unlock()
		return ControlOutcome{}, err
	}

	s.turnWG.Add(1)
	go s.awaitPromptResult(spanID, rpcKey, resCh)

	out := ControlOutcome{
		Action:  ControlPrompt,
		Status:  ControlAccepted,
		SpanID:  spanID,
		InputID: inOpts.InputID,
	}
	controlOutcomeRecord(s.stream, ControlPrompt, inOpts.InputID, "", out)
	return out, nil
}

func (s *acpSession) awaitPromptResult(spanID, rpcKey string, resCh <-chan rpcResult) {
	defer s.turnWG.Done()
	select {
	case <-s.stopTurnCh:
		s.peer.cancelPending(rpcKey)
		return
	case res := <-resCh:
		s.mu.Lock()
		if !s.activeTurn {
			// Turn already settled via onEOF when the process exited.
			s.mu.Unlock()
			return
		}
		s.activeTurn = false
		s.activeSpanID = ""
		s.mu.Unlock()

		var events []Event
		if res.err != nil {
			outcome := TurnOutcome{
				Kind:    "failed",
				Failure: classifyFailure(res.err.Error(), nil),
				Reason:  res.err.Error(),
			}
			events = append(events, Event{Kind: EventTurnEnded, Outcome: &outcome})
		} else {
			var body struct {
				StopReason string          `json:"stopReason"`
				Usage      json.RawMessage `json:"usage"`
				Meta       struct {
					Usage json.RawMessage `json:"usage"`
				} `json:"_meta"`
			}
			_ = json.Unmarshal(res.result, &body)
			outcome := TurnOutcome{Kind: "completed"}
			if body.StopReason == "cancelled" || body.StopReason == "aborted" {
				outcome = TurnOutcome{Kind: "aborted"}
			}
			events = append(events, Event{Kind: EventTurnEnded, Outcome: &outcome})

			usageRaw := body.Usage
			if len(usageRaw) == 0 {
				usageRaw = body.Meta.Usage
			}
			if ev, ok := s.recordUsage(usageRaw); ok {
				events = append(events, ev)
			}
		}

		s.stream.emit(RecordFrame, spanID, []string{}, "session/prompt_result", res.result, events, nil, nil)
		s.drainNextQueued()
	}
}

func (s *acpSession) Steer(ctx context.Context, input string, opts ...InputOption) (ControlOutcome, error) {
	if err := ctx.Err(); err != nil {
		return ControlOutcome{}, err
	}
	inOpts := resolveInputOptions(opts)

	if !s.profile.SupportsSteer {
		out := ControlOutcome{
			Action:  ControlSteer,
			Status:  ControlUnsupported,
			Code:    "unsupported",
			Reason:  fmt.Sprintf("%s ACP does not support mid-turn steer", s.profile.ID),
			InputID: inOpts.InputID,
		}
		controlOutcomeRecord(s.stream, ControlSteer, inOpts.InputID, "", out)
		return out, nil
	}

	s.mu.Lock()
	if s.exited || s.disposed {
		s.mu.Unlock()
		out := controlNotRunning(ControlSteer, "session exited")
		controlOutcomeRecord(s.stream, ControlSteer, inOpts.InputID, "", out)
		return out, nil
	}
	if !s.activeTurn {
		s.mu.Unlock()
		out := ControlOutcome{
			Action:  ControlSteer,
			Status:  ControlRejected,
			Code:    "no_active_turn",
			Reason:  "no active turn to steer",
			InputID: inOpts.InputID,
		}
		controlOutcomeRecord(s.stream, ControlSteer, inOpts.InputID, "", out)
		return out, nil
	}
	rootID := s.rootID
	spanID := s.activeSpanID
	s.mu.Unlock()

	if err := s.peer.notify("session/steer", map[string]any{
		"sessionId": rootID,
		"prompt":    []map[string]any{{"type": "text", "text": input}},
	}); err != nil {
		return ControlOutcome{}, err
	}

	out := ControlOutcome{
		Action:  ControlSteer,
		Status:  ControlAccepted,
		SpanID:  spanID,
		InputID: inOpts.InputID,
	}
	controlOutcomeRecord(s.stream, ControlSteer, inOpts.InputID, "", out)
	return out, nil
}

func (s *acpSession) Queue(ctx context.Context, input string, opts ...InputOption) (ControlOutcome, error) {
	if err := ctx.Err(); err != nil {
		return ControlOutcome{}, err
	}
	inOpts := resolveInputOptions(opts)

	s.mu.Lock()
	if s.exited || s.disposed {
		s.mu.Unlock()
		out := controlNotRunning(ControlQueue, "session exited")
		controlOutcomeRecord(s.stream, ControlQueue, inOpts.InputID, "", out)
		return out, nil
	}
	active := s.activeTurn
	s.mu.Unlock()

	if !active {
		out, err := s.Prompt(ctx, input, opts...)
		if err != nil {
			return out, err
		}
		out.Action = ControlQueue
		return out, nil
	}

	s.queue.push(queuedInput{
		input:   input,
		inputID: inOpts.InputID,
		spanID:  inOpts.SpanID,
	})
	out := ControlOutcome{
		Action:  ControlQueue,
		Status:  ControlAccepted,
		InputID: inOpts.InputID,
		Message: "queued",
	}
	controlOutcomeRecord(s.stream, ControlQueue, inOpts.InputID, "", out)
	return out, nil
}

func (s *acpSession) Withdraw(ctx context.Context, inputID string) (ControlOutcome, error) {
	s.mu.Lock()
	stopped := s.exited || s.disposed
	s.mu.Unlock()
	return withdrawInput(ctx, s.stream, &s.queue, stopped, inputID)
}

func (s *acpSession) Abort(ctx context.Context) (ControlOutcome, error) {
	if err := ctx.Err(); err != nil {
		return ControlOutcome{}, err
	}
	s.mu.Lock()
	if s.exited || s.disposed {
		s.mu.Unlock()
		out := controlNotRunning(ControlAbort, "session exited")
		controlOutcomeRecord(s.stream, ControlAbort, "", "", out)
		return out, nil
	}
	if !s.activeTurn {
		s.mu.Unlock()
		out := ControlOutcome{
			Action: ControlAbort,
			Status: ControlRejected,
			Code:   "no_active_turn",
			Reason: "no active turn to abort",
		}
		controlOutcomeRecord(s.stream, ControlAbort, "", "", out)
		return out, nil
	}
	rootID := s.rootID
	spanID := s.activeSpanID
	s.mu.Unlock()

	if err := s.peer.notify("session/cancel", map[string]any{"sessionId": rootID}); err != nil {
		_ = s.proc.Interrupt()
	}

	out := ControlOutcome{
		Action: ControlAbort,
		Status: ControlAccepted,
		SpanID: spanID,
	}
	controlOutcomeRecord(s.stream, ControlAbort, "", "", out)
	return out, nil
}

func (s *acpSession) Compact(ctx context.Context) (ControlOutcome, error) {
	if err := ctx.Err(); err != nil {
		return ControlOutcome{}, err
	}
	out := ControlOutcome{
		Action: ControlCompact,
		Status: ControlUnsupported,
		Code:   "unsupported",
		Reason: fmt.Sprintf("%s ACP does not expose manual compaction", s.profile.ID),
	}
	controlOutcomeRecord(s.stream, ControlCompact, "", "", out)
	return out, nil
}

func (s *acpSession) StopTask(ctx context.Context, taskID string) (ControlOutcome, error) {
	if err := ctx.Err(); err != nil {
		return ControlOutcome{}, err
	}
	out := ControlOutcome{
		Action: ControlStopTask,
		Status: ControlUnsupported,
		Code:   "unsupported",
		Reason: fmt.Sprintf("%s ACP does not expose stop_task", s.profile.ID),
	}
	controlOutcomeRecord(s.stream, ControlStopTask, "", taskID, out)
	return out, nil
}

func (s *acpSession) drainStderr() {
	_, _ = io.Copy(io.Discard, s.proc.Stderr())
}

func (s *acpSession) runReader() {
	s.peer.readLoop(s.proc.Stdout())
}

func (s *acpSession) onEOF(readErr error) {
	exitStat, waitErr := s.proc.Wait()

	s.mu.Lock()
	s.exited = true
	wasTurn := s.activeTurn
	spanID := s.activeSpanID
	disposed := s.disposed
	s.activeTurn = false
	s.activeSpanID = ""
	s.mu.Unlock()

	s.queue.clear()

	if wasTurn {
		outcome := TurnOutcome{Kind: "aborted"}
		if !disposed && exitStat.Code != 0 {
			outcome = TurnOutcome{
				Kind:    "failed",
				Failure: FailureUnknown,
				Reason:  fmt.Sprintf("%s exited unexpectedly (code %d)", s.profile.ID, exitStat.Code),
			}
		}
		s.stream.emit(RecordMarker, spanID, []string{}, "turn_ended", nil, []Event{{
			Kind:    EventTurnEnded,
			Outcome: &outcome,
		}}, nil, nil)
	}

	code := exitStat.Code
	s.stream.emit(RecordMarker, "", []string{}, "exited", nil, []Event{{
		Kind:   EventExited,
		Code:   &code,
		Signal: exitStat.Signal,
	}}, nil, &MarkerRecord{Name: "exited"})

	if readErr != nil && !errors.Is(readErr, io.EOF) {
		s.waitErr = readErr
	} else if !disposed {
		s.waitErr = waitErr
	}
	close(s.doneCh)
}

func (s *acpSession) onServerRequest(_ json.RawMessage, method string, params json.RawMessage, raw []byte) (any, *rpcError) {
	if method == "session/request_permission" {
		s.stream.emit(RecordFrame, "", []string{}, method, raw, nil, nil, nil)
		var req struct {
			Options []struct {
				OptionID string `json:"optionId"`
				Kind     string `json:"kind"`
			} `json:"options"`
		}
		_ = json.Unmarshal(params, &req)
		optionID := ""
		for _, opt := range req.Options {
			if strings.Contains(opt.Kind, "allow") {
				optionID = opt.OptionID
				break
			}
		}
		if optionID == "" && len(req.Options) > 0 {
			optionID = req.Options[0].OptionID
		}
		return map[string]any{
			"outcome": map[string]any{
				"outcome":  "selected",
				"optionId": optionID,
			},
		}, nil
	}
	return nil, &rpcError{Code: -32601, Message: "unsupported ACP client request: " + method}
}

func (s *acpSession) onNotification(method string, params json.RawMessage, raw []byte) {
	if method != "session/update" {
		s.stream.emit(RecordFrame, "", []string{}, method, raw, nil, nil, nil)
		return
	}

	var p struct {
		SessionID string          `json:"sessionId"`
		Meta      json.RawMessage `json:"_meta"`
		Update    struct {
			SessionUpdate string          `json:"sessionUpdate"`
			ToolCallID    string          `json:"toolCallId"`
			Title         string          `json:"title"`
			Name          string          `json:"name"`
			Kind          string          `json:"kind"`
			Status        string          `json:"status"`
			RawInput      json.RawMessage `json:"rawInput"`
			RawOutput     json.RawMessage `json:"rawOutput"`
			Meta          json.RawMessage `json:"_meta"`
			Usage         json.RawMessage `json:"usage"`
			Content       json.RawMessage `json:"content"`
		} `json:"update"`
	}
	_ = json.Unmarshal(params, &p)

	childID, parentID := parseOpenCodeChildSessionMeta(p.Meta)
	if childID == "" {
		childID, parentID = parseOpenCodeChildSessionMeta(p.Update.Meta)
	}
	effectiveSession := p.SessionID
	if childID != "" {
		if parentID == "" {
			parentID = p.SessionID
		}
		s.registerChildSession(parentID, childID)
		effectiveSession = childID
	}

	agentPath := s.resolveChildAgentPath(effectiveSession)
	s.mu.Lock()
	spanID := s.activeSpanID
	s.mu.Unlock()

	var events []Event
	switch p.Update.SessionUpdate {
	case "agent_message_chunk":
		if txt := parseACPTextContent(p.Update.Content); txt != "" {
			events = append(events, Event{Kind: EventTextDelta, Text: txt})
		}
	case "agent_thought_chunk":
		if txt := parseACPTextContent(p.Update.Content); txt != "" {
			events = append(events, Event{Kind: EventReasoning, ReasoningKind: "text", Text: txt})
		}
	case "tool_call":
		toolName := firstNonEmpty(p.Update.Name, p.Update.Title, p.Update.Kind, "tool")
		inStr := strings.TrimSpace(string(p.Update.RawInput))
		if inStr == "null" {
			inStr = ""
		}
		events = append(events, Event{
			Kind:   EventToolCallStarted,
			CallID: p.Update.ToolCallID,
			Tool:   toolName,
			Input:  inStr,
		})
	case "tool_call_update":
		if len(p.Update.RawInput) > 0 && string(p.Update.RawInput) != "null" {
			events = append(events, Event{
				Kind:   EventToolCallInput,
				CallID: p.Update.ToolCallID,
				Input:  string(p.Update.RawInput),
			})
		}
		st := strings.ToLower(p.Update.Status)
		if st == "completed" || st == "failed" || st == "error" {
			res := "ok"
			if st == "failed" || st == "error" {
				res = "failed"
			}
			var parts []ToolOutputPart
			if txt := parseACPOutputContent(p.Update.Content, p.Update.RawOutput); txt != "" {
				parts = []ToolOutputPart{{Type: "text", Text: txt}}
			}
			events = append(events, Event{
				Kind:    EventToolCallEnded,
				CallID:  p.Update.ToolCallID,
				Result:  res,
				Content: parts,
			})
		}
	case "usage_update":
		usageRaw := p.Update.Usage
		if len(usageRaw) == 0 {
			usageRaw = p.Update.Content
		}
		if ev, ok := s.recordUsage(usageRaw); ok {
			events = append(events, ev)
		}
	}

	s.stream.emit(RecordFrame, spanID, agentPath, "session/update/"+p.Update.SessionUpdate, raw, events, nil, nil)
}

func (s *acpSession) registerChildSession(parentID, childID string) {
	if childID == "" {
		return
	}
	s.mu.Lock()
	if parentID == "" {
		parentID = s.rootID
	}
	if childID == s.rootID {
		s.mu.Unlock()
		return
	}
	if _, exists := s.childPaths[childID]; exists {
		s.mu.Unlock()
		return
	}
	parentPath := s.childPaths[parentID]
	next := make([]string, len(parentPath)+1)
	copy(next, parentPath)
	next[len(parentPath)] = childID
	s.childPaths[childID] = next
	s.mu.Unlock()

	s.stream.emit(RecordMarker, "", next, "child_session_associated", nil, []Event{{
		Kind:            EventChildSession,
		ChildSessionID:  childID,
		ParentSessionID: parentID,
	}}, nil, nil)
}

func (s *acpSession) resolveChildAgentPath(sessionID string) []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if sessionID == "" || sessionID == s.rootID {
		return []string{}
	}
	if p, ok := s.childPaths[sessionID]; ok {
		return append([]string(nil), p...)
	}
	next := []string{sessionID}
	s.childPaths[sessionID] = next
	return append([]string(nil), next...)
}

func (s *acpSession) recordUsage(raw json.RawMessage) (Event, bool) {
	if len(raw) == 0 {
		return Event{}, false
	}
	tot, ok := parseCodexTokenTotals(raw)
	if !ok {
		return Event{}, false
	}
	s.mu.Lock()
	resumed := s.resumed
	if !resumed {
		if s.usage == nil {
			s.usage = tot.Clone()
		} else {
			sum := s.usage.Add(tot)
			s.usage = &sum
		}
	}
	current := s.usage.Clone()
	s.mu.Unlock()

	if resumed {
		// ACP provides no pre-turn Resume baseline query; do not fabricate cumulative deltas.
		return Event{
			Kind: EventUsage,
			Usage: &UsageReport{
				Tokens:        nil,
				UnknownReason: "acp_resume_baseline_unknown",
			},
		}, true
	}
	return Event{
		Kind: EventUsage,
		Usage: &UsageReport{
			Tokens: current,
		},
	}, true
}

func parseOpenCodeChildSessionMeta(metaRaw json.RawMessage) (childID, parentID string) {
	if len(metaRaw) == 0 {
		return "", ""
	}
	var m map[string]json.RawMessage
	if json.Unmarshal(metaRaw, &m) != nil {
		return "", ""
	}
	val, ok := m["opencode/child-session"]
	if !ok || len(val) == 0 || string(val) == "null" {
		return "", ""
	}
	var asStr string
	if json.Unmarshal(val, &asStr) == nil && asStr != "" {
		return asStr, ""
	}
	var obj struct {
		SessionID       string `json:"sessionId"`
		ChildSessionID  string `json:"childSessionId"`
		ID              string `json:"id"`
		ParentSessionID string `json:"parentSessionId"`
		ParentID        string `json:"parentId"`
	}
	if json.Unmarshal(val, &obj) == nil {
		return firstNonEmpty(obj.ChildSessionID, obj.SessionID, obj.ID), firstNonEmpty(obj.ParentSessionID, obj.ParentID)
	}
	return "", ""
}

func parseACPTextContent(raw json.RawMessage) string {
	if len(raw) == 0 {
		return ""
	}
	var single struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &single) == nil && single.Text != "" {
		return single.Text
	}
	var list []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &list) == nil {
		var b strings.Builder
		for _, item := range list {
			b.WriteString(item.Text)
		}
		return b.String()
	}
	var plain string
	if json.Unmarshal(raw, &plain) == nil {
		return plain
	}
	return ""
}

func parseACPOutputContent(content, rawOutput json.RawMessage) string {
	if txt := parseACPTextContent(content); txt != "" {
		return txt
	}
	var wrapped []struct {
		Type    string          `json:"type"`
		Content json.RawMessage `json:"content"`
	}
	if len(content) > 0 && json.Unmarshal(content, &wrapped) == nil {
		var b strings.Builder
		for _, w := range wrapped {
			b.WriteString(parseACPTextContent(w.Content))
		}
		if b.Len() > 0 {
			return b.String()
		}
	}
	if len(rawOutput) > 0 && string(rawOutput) != "null" {
		var s string
		if json.Unmarshal(rawOutput, &s) == nil {
			return s
		}
		return strings.TrimSpace(string(rawOutput))
	}
	return ""
}

func (s *acpSession) drainNextQueued() {
	drainQueued(&s.queue, func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return !s.exited && !s.disposed && !s.activeTurn
	}, s.Prompt, &s.drainWG)
}
