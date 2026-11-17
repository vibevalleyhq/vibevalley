package oar

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// CodexDriver drives OpenAI Codex CLI via its bidirectional app-server thread JSON-RPC protocol.
type CodexDriver struct{}

// NewCodexDriver constructs the Codex runtime driver.
func NewCodexDriver() CodexDriver { return CodexDriver{} }

// ID returns "codex".
func (CodexDriver) ID() string { return "codex" }

// RefusedOptions declares session options rejected prior to spawning codex app-server.
func (CodexDriver) RefusedOptions() RefusedOptions {
	return RefusedOptions{
		OptionAllowedTools:          "codex app-server does not accept an allowedTools allowlist",
		OptionAdditionalDirectories: "codex driver does not support additionalDirectories",
		OptionName:                  "codex app-server does not support a session display name",
		OptionServiceTier:           "codex driver does not expose serviceTier",
		OptionLaunchArgs:            "codex driver does not accept raw launchArgs",
	}
}

// Open validates options pre-spawn, launches `codex app-server`, initializes JSON-RPC,
// starts or resumes the root thread, and captures any Resume token usage baseline.
func (d CodexDriver) Open(ctx context.Context, opts SessionOptions) (Session, error) {
	if err := ValidateOptions(d.ID(), d.RefusedOptions(), opts); err != nil {
		return nil, err
	}

	cmd := opts.BinPath
	if cmd == "" {
		cmd = "codex"
	}
	spec := LaunchSpec{
		Command: cmd,
		Args:    []string{"app-server"},
		Dir:     opts.CWD,
		Env:     buildEnv(opts, nil),
	}

	proc, err := opts.launcher().Launch(ctx, spec)
	if err != nil {
		return nil, err
	}

	initialID := opts.ResumeSessionID
	if initialID == "" {
		initialID = "codex-pending"
	}

	s := &codexSession{
		opts:         opts,
		proc:         proc,
		stream:       newRecordStream(initialID, opts.nowMillis),
		rootThreadID: opts.ResumeSessionID,
		resumed:      opts.ResumeSessionID != "",
		baselineCh:   make(chan struct{}),
		threadPaths:  make(map[string][]string),
		threadTokens: make(map[string]TokenTotals),
		doneCh:       make(chan struct{}),
	}
	if opts.ResumeSessionID != "" {
		s.threadPaths[opts.ResumeSessionID] = []string{}
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

type codexSession struct {
	opts   SessionOptions
	proc   Process
	peer   *rpcPeer
	stream *recordStream
	queue  inputQueue

	nextSpanSeq atomic.Int64
	drainWG     sync.WaitGroup

	mu              sync.Mutex
	rootThreadID    string
	activeTurn      bool
	activeTurnID    string
	compacting      bool
	turnsStarted    int
	seenTurnStarted bool
	exited          bool
	disposed        bool
	resumed         bool
	baselineKnown   bool
	baselineCh      chan struct{}
	baselineOnce    sync.Once
	baseline        TokenTotals
	rootDeltaUsage  *TokenTotals
	threadPaths     map[string][]string
	threadTokens    map[string]TokenTotals

	doneCh      chan struct{}
	waitErr     error
	disposeOnce sync.Once
	disposeErr  error
}

func (s *codexSession) handshake(ctx context.Context) error {
	reqCtx, cancel := context.WithTimeout(ctx, s.opts.requestTimeout())
	defer cancel()

	if _, err := s.peer.call(reqCtx, "initialize", map[string]any{
		"clientInfo": map[string]any{
			"name":    "vibevalley-oar",
			"version": "1.0.0",
		},
	}); err != nil {
		return fmt.Errorf("oar: codex initialize: %w", err)
	}
	if err := s.peer.notify("initialized", map[string]any{}); err != nil {
		return fmt.Errorf("oar: codex initialized notify: %w", err)
	}

	params := map[string]any{
		"cwd": s.opts.CWD,
	}
	if s.opts.Model != "" {
		params["model"] = s.opts.Model
	}
	if s.opts.SystemPrompt != "" {
		params["baseInstructions"] = s.opts.SystemPrompt
	}
	if s.opts.AppendSystemPrompt != "" {
		params["developerInstructions"] = s.opts.AppendSystemPrompt
	}
	if cfg := codexConfigMap(s.opts); len(cfg) > 0 {
		params["config"] = cfg
	}

	var method string
	if s.resumed {
		method = "thread/resume"
		params["threadId"] = s.opts.ResumeSessionID
	} else {
		method = "thread/start"
	}

	resRaw, err := s.peer.call(reqCtx, method, params)
	if err != nil {
		return fmt.Errorf("oar: codex %s: %w", method, err)
	}

	var res struct {
		ThreadID   string          `json:"threadId"`
		TokenUsage json.RawMessage `json:"tokenUsage"`
		Thread     struct {
			ID         string          `json:"id"`
			TokenUsage json.RawMessage `json:"tokenUsage"`
		} `json:"thread"`
	}
	_ = json.Unmarshal(resRaw, &res)
	threadID := res.Thread.ID
	if threadID == "" {
		threadID = res.ThreadID
	}
	if threadID == "" {
		threadID = s.opts.ResumeSessionID
	}
	if threadID == "" {
		return errors.New("oar: codex thread/start returned no threadId")
	}

	s.stream.setSessionID(threadID)

	s.mu.Lock()
	s.rootThreadID = threadID
	s.threadPaths[threadID] = []string{}
	if s.resumed {
		rawTU := res.Thread.TokenUsage
		if len(rawTU) == 0 {
			rawTU = res.TokenUsage
		}
		if len(rawTU) > 0 {
			if tot, ok := parseCodexTokenTotals(rawTU); ok {
				s.baseline = tot
				s.baselineKnown = true
				s.baselineOnce.Do(func() { close(s.baselineCh) })
			}
		}
		if !s.baselineKnown && !s.seenTurnStarted {
			if tot, ok := s.threadTokens[threadID]; ok {
				delete(s.threadTokens, threadID)
				s.baseline = tot
				s.baselineKnown = true
				s.baselineOnce.Do(func() { close(s.baselineCh) })
			}
		}
	}
	needBaselineWait := s.resumed && !s.baselineKnown
	s.mu.Unlock()

	if needBaselineWait {
		wait := min(s.opts.baselineTimeout(), 50*time.Millisecond)
		if s.opts.BaselineTimeout > 0 {
			wait = s.opts.BaselineTimeout
		}
		timer := time.NewTimer(wait)
		select {
		case <-s.baselineCh:
			timer.Stop()
		case <-timer.C:
		case <-ctx.Done():
			timer.Stop()
			return ctx.Err()
		}
	}

	if s.opts.Model != "" {
		s.stream.emit(RecordFrame, "", []string{}, "thread/model", nil, []Event{{Kind: EventModel, Model: s.opts.Model}}, nil, nil)
	}
	if s.opts.Effort != "" {
		s.stream.emit(RecordFrame, "", []string{}, "thread/effort", nil, []Event{{Kind: EventEffort, Effort: s.opts.Effort}}, nil, nil)
	}
	return nil
}

func codexConfigMap(opts SessionOptions) map[string]any {
	cfg := make(map[string]any)
	if opts.Effort != "" {
		cfg["model_reasoning_effort"] = opts.Effort
	}
	if len(opts.DisallowedTools) > 0 {
		cfg["disallowed_tools"] = opts.DisallowedTools
	}
	if len(opts.MCPServers) > 0 {
		servers := make(map[string]any, len(opts.MCPServers))
		for _, srv := range opts.MCPServers {
			if srv.Type == MCPHTTP {
				entry := map[string]any{"url": srv.URL}
				if len(srv.Headers) > 0 {
					entry["http_headers"] = srv.Headers
				}
				servers[srv.Name] = entry
			} else {
				args := srv.Args
				if args == nil {
					args = []string{}
				}
				entry := map[string]any{
					"command": srv.Command,
					"args":    args,
				}
				if len(srv.Env) > 0 {
					entry["env"] = srv.Env
				}
				servers[srv.Name] = entry
			}
		}
		cfg["mcp_servers"] = servers
	}
	return cfg
}

func (s *codexSession) ID() string      { return s.stream.sessionIDSnapshot() }
func (s *codexSession) Runtime() string { return "codex" }

func (s *codexSession) Records() []RecordEnvelope {
	return s.stream.recordsSnapshot()
}

func (s *codexSession) Subscribe(afterSeq int64, fn func(RecordEnvelope)) func() {
	return s.stream.subscribe(afterSeq, fn)
}

func (s *codexSession) Usage() *TokenTotals {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.resumed && !s.baselineKnown {
		return nil
	}
	if s.rootDeltaUsage == nil && len(s.threadTokens) == 0 {
		return nil
	}
	var sum TokenTotals
	if s.rootDeltaUsage != nil {
		sum = sum.Add(*s.rootDeltaUsage)
	}
	for tid, tok := range s.threadTokens {
		if tid == s.rootThreadID {
			continue
		}
		sum = sum.Add(tok)
	}
	return &sum
}

func (s *codexSession) Wait(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.doneCh:
		return s.waitErr
	}
}

func (s *codexSession) Dispose(ctx context.Context) error {
	s.disposeOnce.Do(func() {
		s.mu.Lock()
		s.disposed = true
		s.mu.Unlock()
		s.queue.clear()
		_ = s.proc.Close()
		<-s.doneCh
		s.drainWG.Wait()
		s.stream.closeSubscribers()
	})
	return s.disposeErr
}

func (s *codexSession) Control(ctx context.Context, action ControlAction, arg string, opts ...InputOption) (ControlOutcome, error) {
	return dispatchControl(ctx, s, action, arg, opts...)
}

func (s *codexSession) Prompt(ctx context.Context, input string, opts ...InputOption) (ControlOutcome, error) {
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
	if s.compacting {
		s.mu.Unlock()
		out := ControlOutcome{
			Action:  ControlPrompt,
			Status:  ControlRejected,
			Code:    "compacting",
			Reason:  "manual compaction is active",
			InputID: inOpts.InputID,
		}
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
	threadID := s.rootThreadID
	spanID := inOpts.SpanID
	if spanID == "" {
		spanID = fmt.Sprintf("codex-turn-%d", s.nextSpanSeq.Add(1))
	}
	s.activeTurn = true
	s.activeTurnID = spanID
	s.turnsStarted++
	s.mu.Unlock()

	s.stream.emit(RecordFrame, spanID, []string{}, "turn/start", nil, []Event{{Kind: EventTurnStarted, Input: input, RequestID: inOpts.InputID}}, nil, nil)

	params := map[string]any{
		"threadId": threadID,
		"input":    []map[string]any{{"type": "text", "text": input}},
	}
	if s.opts.Model != "" {
		params["model"] = s.opts.Model
	}
	if s.opts.Effort != "" {
		params["effort"] = s.opts.Effort
	}
	if len(s.opts.OutputSchema) > 0 {
		params["outputSchema"] = json.RawMessage(s.opts.OutputSchema)
	}

	reqCtx, cancel := context.WithTimeout(ctx, s.opts.requestTimeout())
	resRaw, err := s.peer.call(reqCtx, "turn/start", params)
	cancel()
	if err != nil {
		s.mu.Lock()
		s.activeTurn = false
		s.activeTurnID = ""
		s.mu.Unlock()
		out := ControlOutcome{
			Action:  ControlPrompt,
			Status:  ControlRejected,
			Code:    "turn_start_failed",
			Reason:  err.Error(),
			InputID: inOpts.InputID,
		}
		controlOutcomeRecord(s.stream, ControlPrompt, inOpts.InputID, "", out)
		return out, nil
	}

	var res struct {
		Turn struct {
			ID string `json:"id"`
		} `json:"turn"`
		TurnID string `json:"turnId"`
	}
	if json.Unmarshal(resRaw, &res) == nil {
		if nativeID := firstNonEmpty(res.Turn.ID, res.TurnID); nativeID != "" {
			s.mu.Lock()
			if s.activeTurn {
				s.activeTurnID = nativeID
				spanID = nativeID
			}
			s.mu.Unlock()
		}
	}

	out := ControlOutcome{
		Action:  ControlPrompt,
		Status:  ControlAccepted,
		SpanID:  spanID,
		InputID: inOpts.InputID,
	}
	controlOutcomeRecord(s.stream, ControlPrompt, inOpts.InputID, "", out)
	return out, nil
}

func (s *codexSession) Steer(ctx context.Context, input string, opts ...InputOption) (ControlOutcome, error) {
	if err := ctx.Err(); err != nil {
		return ControlOutcome{}, err
	}
	inOpts := resolveInputOptions(opts)

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
	threadID := s.rootThreadID
	turnID := s.activeTurnID
	s.mu.Unlock()

	reqCtx, cancel := context.WithTimeout(ctx, s.opts.requestTimeout())
	_, err := s.peer.call(reqCtx, "turn/steer", map[string]any{
		"threadId":       threadID,
		"expectedTurnId": turnID,
		"input":          []map[string]any{{"type": "text", "text": input}},
	})
	cancel()
	if err != nil {
		out := ControlOutcome{
			Action:  ControlSteer,
			Status:  ControlRejected,
			Code:    "steer_failed",
			Reason:  err.Error(),
			SpanID:  turnID,
			InputID: inOpts.InputID,
		}
		controlOutcomeRecord(s.stream, ControlSteer, inOpts.InputID, "", out)
		return out, nil
	}

	out := ControlOutcome{
		Action:  ControlSteer,
		Status:  ControlAccepted,
		SpanID:  turnID,
		InputID: inOpts.InputID,
	}
	controlOutcomeRecord(s.stream, ControlSteer, inOpts.InputID, "", out)
	return out, nil
}

func (s *codexSession) Queue(ctx context.Context, input string, opts ...InputOption) (ControlOutcome, error) {
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
	// Reject Queue during active manual compaction so queued items cannot jump ahead of compaction boundary.
	if s.compacting {
		s.mu.Unlock()
		out := ControlOutcome{
			Action:  ControlQueue,
			Status:  ControlRejected,
			Code:    "compacting",
			Reason:  "cannot queue inputs while manual compaction is active",
			InputID: inOpts.InputID,
		}
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

func (s *codexSession) Withdraw(ctx context.Context, inputID string) (ControlOutcome, error) {
	s.mu.Lock()
	stopped := s.exited || s.disposed
	s.mu.Unlock()
	return withdrawInput(ctx, s.stream, &s.queue, stopped, inputID)
}

func (s *codexSession) Abort(ctx context.Context) (ControlOutcome, error) {
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
	if !s.activeTurn && !s.compacting {
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
	threadID := s.rootThreadID
	turnID := s.activeTurnID
	s.mu.Unlock()

	reqCtx, cancel := context.WithTimeout(ctx, s.opts.requestTimeout())
	_, err := s.peer.call(reqCtx, "turn/interrupt", map[string]any{
		"threadId": threadID,
		"turnId":   turnID,
	})
	cancel()
	if err != nil {
		_ = s.proc.Interrupt()
	}

	out := ControlOutcome{
		Action: ControlAbort,
		Status: ControlAccepted,
		SpanID: turnID,
	}
	controlOutcomeRecord(s.stream, ControlAbort, "", "", out)
	return out, nil
}

func (s *codexSession) Compact(ctx context.Context) (ControlOutcome, error) {
	if err := ctx.Err(); err != nil {
		return ControlOutcome{}, err
	}
	s.mu.Lock()
	if s.exited || s.disposed {
		s.mu.Unlock()
		out := controlNotRunning(ControlCompact, "session exited")
		controlOutcomeRecord(s.stream, ControlCompact, "", "", out)
		return out, nil
	}
	if s.activeTurn || s.compacting {
		s.mu.Unlock()
		out := ControlOutcome{
			Action: ControlCompact,
			Status: ControlRejected,
			Code:   "busy",
			Reason: "cannot compact while turn or compaction is active",
		}
		controlOutcomeRecord(s.stream, ControlCompact, "", "", out)
		return out, nil
	}
	threadID := s.rootThreadID
	s.compacting = true
	s.mu.Unlock()

	s.stream.emit(RecordFrame, "", []string{}, "compaction_started", nil, []Event{{Kind: EventCompactionStarted, Trigger: "manual"}}, nil, nil)

	reqCtx, cancel := context.WithTimeout(ctx, s.opts.requestTimeout())
	_, err := s.peer.call(reqCtx, "thread/compact/start", map[string]any{"threadId": threadID})
	cancel()
	if err != nil {
		s.mu.Lock()
		s.compacting = false
		s.mu.Unlock()
		s.stream.emit(RecordFrame, "", []string{}, "compaction_ended", nil, []Event{{Kind: EventCompactionEnded, CompactionOutcome: "failed"}}, nil, nil)

		status := ControlRejected
		code := "compact_failed"
		var rerr *rpcError
		if errors.As(err, &rerr) && rerr.Code == -32601 {
			status = ControlUnsupported
			code = "unsupported"
		}
		out := ControlOutcome{
			Action: ControlCompact,
			Status: status,
			Code:   code,
			Reason: err.Error(),
		}
		controlOutcomeRecord(s.stream, ControlCompact, "", "", out)
		return out, nil
	}

	out := ControlOutcome{
		Action: ControlCompact,
		Status: ControlAccepted,
	}
	controlOutcomeRecord(s.stream, ControlCompact, "", "", out)
	return out, nil
}

func (s *codexSession) StopTask(ctx context.Context, taskID string) (ControlOutcome, error) {
	if err := ctx.Err(); err != nil {
		return ControlOutcome{}, err
	}
	out := ControlOutcome{
		Action: ControlStopTask,
		Status: ControlUnsupported,
		Code:   "unsupported",
		Reason: "codex app-server does not expose stop_task",
	}
	controlOutcomeRecord(s.stream, ControlStopTask, "", taskID, out)
	return out, nil
}

func (s *codexSession) drainStderr() {
	_, _ = io.Copy(io.Discard, s.proc.Stderr())
}

func (s *codexSession) runReader() {
	s.peer.readLoop(s.proc.Stdout())
}

func (s *codexSession) onEOF(readErr error) {
	exitStat, waitErr := s.proc.Wait()

	s.mu.Lock()
	s.exited = true
	wasTurn := s.activeTurn
	wasCompacting := s.compacting
	spanID := s.activeTurnID
	disposed := s.disposed
	s.activeTurn = false
	s.compacting = false
	s.activeTurnID = ""
	s.mu.Unlock()

	s.queue.clear()

	if wasCompacting {
		s.stream.emit(RecordMarker, spanID, []string{}, "compaction_ended", nil, []Event{{
			Kind:              EventCompactionEnded,
			CompactionOutcome: "aborted",
		}}, nil, nil)
	}
	if wasTurn {
		outcome := TurnOutcome{Kind: "aborted"}
		if !disposed && exitStat.Code != 0 {
			outcome = TurnOutcome{
				Kind:    "failed",
				Failure: FailureUnknown,
				Reason:  fmt.Sprintf("codex exited unexpectedly (code %d)", exitStat.Code),
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

func (s *codexSession) onServerRequest(_ json.RawMessage, method string, _ json.RawMessage, raw []byte) (any, *rpcError) {
	// Workers execute without interactive approval prompts; record and approve tool/command approval requests.
	switch method {
	case "item/commandExecution/requestApproval", "item/fileChange/requestApproval":
		s.stream.emit(RecordFrame, "", []string{}, method, raw, nil, nil, nil)
		return map[string]any{"decision": "accept"}, nil
	default:
		return nil, &rpcError{Code: -32601, Message: "unsupported server request: " + method}
	}
}

func (s *codexSession) onNotification(method string, params json.RawMessage, raw []byte) {
	var p struct {
		ThreadID         string          `json:"threadId"`
		ParentThreadID   string          `json:"parentThreadId"`
		TurnID           string          `json:"turnId"`
		ItemID           string          `json:"itemId"`
		Delta            string          `json:"delta"`
		TokenUsage       json.RawMessage `json:"tokenUsage"`
		SubAgentActivity struct {
			AgentThreadID string `json:"agentThreadId"`
		} `json:"subAgentActivity"`
		Thread struct {
			ID             string `json:"id"`
			ParentThreadID string `json:"parentThreadId"`
			Source         struct {
				Subagent struct {
					ParentThreadID string `json:"parentThreadId"`
					ThreadID       string `json:"threadId"`
				} `json:"subagent"`
			} `json:"source"`
		} `json:"thread"`
		Turn struct {
			ID     string `json:"id"`
			Status string `json:"status"`
			Error  struct {
				Message string `json:"message"`
			} `json:"error"`
		} `json:"turn"`
		Item struct {
			ID                string   `json:"id"`
			Type              string   `json:"type"`
			Text              string   `json:"text"`
			Command           string   `json:"command"`
			Output            string   `json:"output"`
			AggregatedOutput  string   `json:"aggregatedOutput"`
			ExitCode          *int     `json:"exitCode"`
			Status            string   `json:"status"`
			Tool              string   `json:"tool"`
			Server            string   `json:"server"`
			Arguments         any      `json:"arguments"`
			AgentThreadID     string   `json:"agentThreadId"`
			NewThreadID       string   `json:"newThreadId"`
			ReceiverThreadIDs []string `json:"receiverThreadIds"`
		} `json:"item"`
	}
	_ = json.Unmarshal(params, &p)

	threadID := firstNonEmpty(p.ThreadID, p.Thread.ID)
	if p.SubAgentActivity.AgentThreadID != "" {
		s.associateChildThread(threadID, p.SubAgentActivity.AgentThreadID)
		// Notifications carrying subAgentActivity often identify the child thread in agentThreadId.
		threadID = p.SubAgentActivity.AgentThreadID
	}
	if method == "thread/started" && p.Thread.ID != "" {
		parentID := firstNonEmpty(p.ParentThreadID, p.Thread.ParentThreadID, p.Thread.Source.Subagent.ParentThreadID)
		if parentID != "" {
			s.associateChildThread(parentID, p.Thread.ID)
		}
	}
	if p.Item.Type == "collabAgentToolCall" {
		if p.Item.AgentThreadID != "" {
			s.associateChildThread(threadID, p.Item.AgentThreadID)
		}
		if p.Item.NewThreadID != "" {
			s.associateChildThread(threadID, p.Item.NewThreadID)
		}
		for _, rid := range p.Item.ReceiverThreadIDs {
			s.associateChildThread(threadID, rid)
		}
	}

	agentPath, isRoot := s.agentPathForThread(threadID)
	spanID := firstNonEmpty(p.TurnID, p.Turn.ID)
	if spanID == "" && isRoot {
		s.mu.Lock()
		spanID = s.activeTurnID
		s.mu.Unlock()
	}

	var events []Event
	turnFinished := false

	switch method {
	case "turn/started":
		if isRoot {
			s.mu.Lock()
			s.seenTurnStarted = true
			if s.turnsStarted == 0 {
				s.turnsStarted = 1
			}
			if p.Turn.ID != "" {
				s.activeTurnID = p.Turn.ID
				spanID = p.Turn.ID
			}
			s.mu.Unlock()
		}

	case "item/agentMessage/delta":
		if p.Delta != "" {
			events = append(events, Event{Kind: EventTextDelta, Text: p.Delta})
		}

	case "item/reasoning/summaryTextDelta", "item/reasoning/textDelta":
		if p.Delta != "" {
			events = append(events, Event{Kind: EventReasoning, ReasoningKind: "text", Text: p.Delta})
		}

	case "item/started":
		switch p.Item.Type {
		case "contextCompaction", "compaction":
			if isRoot {
				s.mu.Lock()
				already := s.compacting
				s.compacting = true
				s.mu.Unlock()
				if !already {
					events = append(events, Event{Kind: EventCompactionStarted, Trigger: "auto"})
				}
			}
		case "commandExecution":
			inputBytes, _ := json.Marshal(map[string]string{"command": p.Item.Command})
			events = append(events, Event{Kind: EventToolCallStarted, CallID: p.Item.ID, Tool: "bash", Input: string(inputBytes)})
		case "mcpToolCall":
			inputBytes, _ := json.Marshal(p.Item.Arguments)
			name := p.Item.Tool
			if p.Item.Server != "" {
				name = p.Item.Server + "/" + p.Item.Tool
			}
			events = append(events, Event{Kind: EventToolCallStarted, CallID: p.Item.ID, Tool: name, Input: string(inputBytes)})
		case "fileChange", "webSearch", "collabAgentToolCall":
			inputBytes, _ := json.Marshal(p.Item)
			events = append(events, Event{Kind: EventToolCallStarted, CallID: p.Item.ID, Tool: p.Item.Type, Input: string(inputBytes)})
		}

	case "item/completed":
		switch p.Item.Type {
		case "contextCompaction", "compaction":
			if isRoot {
				s.mu.Lock()
				s.compacting = false
				s.mu.Unlock()
				events = append(events, Event{Kind: EventCompactionEnded, CompactionOutcome: "completed"})
			}
		case "commandExecution", "mcpToolCall", "fileChange", "webSearch", "collabAgentToolCall":
			res := "ok"
			if p.Item.Status == "failed" || (p.Item.ExitCode != nil && *p.Item.ExitCode != 0) {
				res = "failed"
			}
			outText := firstNonEmpty(p.Item.AggregatedOutput, p.Item.Output, p.Item.Text)
			var parts []ToolOutputPart
			if outText != "" {
				parts = []ToolOutputPart{{Type: "text", Text: outText}}
			}
			events = append(events, Event{
				Kind:     EventToolCallEnded,
				CallID:   p.Item.ID,
				Result:   res,
				ExitCode: p.Item.ExitCode,
				Content:  parts,
			})
		}

	case "thread/tokenUsage/updated":
		if ev, emit := s.handleTokenUsage(threadID, p.TurnID, isRoot, p.TokenUsage); emit {
			events = append(events, ev)
		}

	case "turn/completed":
		if isRoot {
			status := strings.ToLower(p.Turn.Status)
			s.mu.Lock()
			wasCompacting := s.compacting
			s.compacting = false
			s.activeTurn = false
			s.activeTurnID = ""
			s.mu.Unlock()

			if wasCompacting {
				compOutcome := "completed"
				if status == "interrupted" || status == "aborted" || status == "cancelled" {
					compOutcome = "aborted"
				} else if status == "failed" || status == "error" {
					compOutcome = "failed"
				}
				events = append(events, Event{Kind: EventCompactionEnded, CompactionOutcome: compOutcome})
			} else {
				var outcome TurnOutcome
				switch status {
				case "interrupted", "aborted", "cancelled":
					outcome = TurnOutcome{Kind: "aborted"}
				case "failed", "error":
					outcome = TurnOutcome{
						Kind:    "failed",
						Failure: classifyFailure(p.Turn.Error.Message, nil),
						Reason:  p.Turn.Error.Message,
					}
				default:
					outcome = TurnOutcome{Kind: "completed"}
				}
				events = append(events, Event{Kind: EventTurnEnded, Outcome: &outcome})
			}
			turnFinished = true
		}
	}

	s.stream.emit(RecordFrame, spanID, agentPath, method, raw, events, nil, nil)

	if turnFinished {
		s.drainNextQueued()
	}
}

func (s *codexSession) associateChildThread(parentThreadID, childThreadID string) {
	if childThreadID == "" {
		return
	}
	s.mu.Lock()
	if parentThreadID == "" {
		parentThreadID = s.rootThreadID
	}
	if childThreadID == s.rootThreadID {
		s.mu.Unlock()
		return
	}
	if _, exists := s.threadPaths[childThreadID]; exists {
		s.mu.Unlock()
		return
	}
	parentPath := s.threadPaths[parentThreadID]
	next := make([]string, len(parentPath)+1)
	copy(next, parentPath)
	next[len(parentPath)] = childThreadID
	s.threadPaths[childThreadID] = next
	s.mu.Unlock()

	s.stream.emit(RecordMarker, "", next, "child_thread_associated", nil, []Event{{
		Kind:            EventChildSession,
		ChildSessionID:  childThreadID,
		ParentSessionID: parentThreadID,
	}}, nil, nil)
}

func (s *codexSession) agentPathForThread(threadID string) (path []string, isRoot bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if threadID == "" || threadID == s.rootThreadID {
		return []string{}, true
	}
	if p, ok := s.threadPaths[threadID]; ok {
		return append([]string(nil), p...), false
	}
	return []string{threadID}, false
}

func (s *codexSession) handleTokenUsage(threadID, notifTurnID string, isRoot bool, raw json.RawMessage) (Event, bool) {
	if len(raw) == 0 {
		return Event{}, false
	}
	tot, ok := parseCodexTokenTotals(raw)
	ctxReport := parseCodexContextUsage(raw)

	if !isRoot {
		if !ok {
			if ctxReport == nil {
				return Event{}, false
			}
			return Event{Kind: EventUsage, Usage: &UsageReport{Tokens: nil, Context: ctxReport}}, true
		}
		s.mu.Lock()
		s.threadTokens[threadID] = tot
		s.mu.Unlock()
		return Event{Kind: EventUsage, Usage: &UsageReport{Tokens: &tot, Context: ctxReport}}, true
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	if s.resumed && !s.baselineKnown && notifTurnID == "" && !s.seenTurnStarted {
		// Pre-turn lifetime total reported right after thread/resume: capture as baseline, do not emit as turn cost.
		if ok {
			s.baseline = tot
			s.baselineKnown = true
			s.baselineOnce.Do(func() { close(s.baselineCh) })
		}
		return Event{}, false
	}

	if s.resumed && !s.baselineKnown {
		s.rootDeltaUsage = nil
		return Event{
			Kind: EventUsage,
			Usage: &UsageReport{
				Tokens:        nil,
				Context:       ctxReport,
				UnknownReason: "missing_codex_resume_baseline",
			},
		}, true
	}

	if !ok {
		if ctxReport == nil {
			return Event{}, false
		}
		return Event{Kind: EventUsage, Usage: &UsageReport{Tokens: nil, Context: ctxReport}}, true
	}

	delta := tot
	if s.resumed {
		delta = tot.Subtract(s.baseline)
	}
	s.rootDeltaUsage = delta.Clone()
	return Event{Kind: EventUsage, Usage: &UsageReport{Tokens: &delta, Context: ctxReport}}, true
}

func parseCodexTokenTotals(raw json.RawMessage) (TokenTotals, bool) {
	var wrapper struct {
		Total json.RawMessage `json:"total"`
		Usage json.RawMessage `json:"usage"`
	}
	target := raw
	if json.Unmarshal(raw, &wrapper) == nil {
		if len(wrapper.Total) > 0 {
			target = wrapper.Total
		} else if len(wrapper.Usage) > 0 {
			target = wrapper.Usage
		}
	}

	var f struct {
		InputTokens       *int64   `json:"inputTokens"`
		InputTokensSnake  *int64   `json:"input_tokens"`
		OutputTokens      *int64   `json:"outputTokens"`
		OutputTokensSnake *int64   `json:"output_tokens"`
		CachedInput       *int64   `json:"cachedInputTokens"`
		CacheRead         *int64   `json:"cacheReadTokens"`
		CacheReadShort    *int64   `json:"cacheRead"`
		CacheReadSnake    *int64   `json:"cache_read_input_tokens"`
		CacheCreation     *int64   `json:"cacheCreationInputTokens"`
		CacheWrite        *int64   `json:"cacheWriteTokens"`
		CacheWriteShort   *int64   `json:"cacheWrite"`
		CacheWriteSnake   *int64   `json:"cache_creation_input_tokens"`
		ReasoningOutput   *int64   `json:"reasoningOutputTokens"`
		Reasoning         *int64   `json:"reasoningTokens"`
		ReasoningShort    *int64   `json:"reasoning"`
		ReasoningSnake    *int64   `json:"reasoning_output_tokens"`
		CostMicros        *int64   `json:"costMicros"`
		CostUSD           *float64 `json:"costUSD"`
		CostUSDSnake      *float64 `json:"cost_usd"`
	}
	if json.Unmarshal(target, &f) != nil {
		return TokenTotals{}, false
	}
	inPtr := firstInt64Ptr(f.InputTokens, f.InputTokensSnake)
	outPtr := firstInt64Ptr(f.OutputTokens, f.OutputTokensSnake)
	if inPtr == nil && outPtr == nil {
		return TokenTotals{}, false
	}

	tot := TokenTotals{
		InputTokens:      valOrZero(inPtr),
		OutputTokens:     valOrZero(outPtr),
		CacheReadTokens:  valOrZero(firstInt64Ptr(f.CachedInput, f.CacheRead, f.CacheReadShort, f.CacheReadSnake)),
		CacheWriteTokens: valOrZero(firstInt64Ptr(f.CacheCreation, f.CacheWrite, f.CacheWriteShort, f.CacheWriteSnake)),
		ReasoningTokens:  valOrZero(firstInt64Ptr(f.ReasoningOutput, f.Reasoning, f.ReasoningShort, f.ReasoningSnake)),
	}
	if f.CostMicros != nil {
		v := *f.CostMicros
		tot.CostMicros = &v
	} else if c := firstCostMicros(f.CostUSDSnake, f.CostUSD); c != nil {
		tot.CostMicros = c
	}
	return tot, true
}

func parseCodexContextUsage(raw json.RawMessage) *ContextUsage {
	var ctxInfo struct {
		ModelContextWindow int64 `json:"modelContextWindow"`
		Last               struct {
			InputTokens       int64 `json:"inputTokens"`
			CachedInputTokens int64 `json:"cachedInputTokens"`
			OutputTokens      int64 `json:"outputTokens"`
		} `json:"last"`
	}
	if json.Unmarshal(raw, &ctxInfo) != nil || ctxInfo.ModelContextWindow <= 0 {
		return nil
	}
	used := ctxInfo.Last.InputTokens + ctxInfo.Last.CachedInputTokens + ctxInfo.Last.OutputTokens
	if used <= 0 {
		return nil
	}
	return &ContextUsage{
		Tokens:        used,
		ContextWindow: ctxInfo.ModelContextWindow,
		Percent:       math.Min(100, (float64(used)/float64(ctxInfo.ModelContextWindow))*100),
	}
}

func (s *codexSession) drainNextQueued() {
	drainQueued(&s.queue, func() bool {
		s.mu.Lock()
		defer s.mu.Unlock()
		return !s.exited && !s.disposed && !s.activeTurn && !s.compacting
	}, s.Prompt, &s.drainWG)
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

func firstInt64Ptr(ptrs ...*int64) *int64 {
	for _, p := range ptrs {
		if p != nil {
			return p
		}
	}
	return nil
}

func valOrZero(p *int64) int64 {
	if p == nil {
		return 0
	}
	return *p
}
