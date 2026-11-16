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
)

type streamJSONConfig struct {
	runtimeID        string
	supportsSteer    bool
	supportsCompact  bool
	supportsStopTask bool
	// usageIsPerTurn indicates result.usage reports single-query totals rather than cumulative session totals.
	usageIsPerTurn bool
	// probeUsageOnResume issues a pre-turn get_usage control_request when ResumeSessionID != "".
	probeUsageOnResume bool
	// sendInitializeFirst sends a control_request initialize as the first stdin frame.
	sendInitializeFirst bool
	initializePayload   map[string]any
}

type modelUsageEntry struct {
	InputTokens           int64    `json:"input_tokens"`
	InputTokensCamel      int64    `json:"inputTokens"`
	OutputTokens          int64    `json:"output_tokens"`
	OutputTokensCamel     int64    `json:"outputTokens"`
	CacheReadTokens       int64    `json:"cache_read_input_tokens"`
	CacheReadTokensCamel  int64    `json:"cacheReadInputTokens"`
	CacheReadShort        int64    `json:"cacheReadTokens"`
	CacheWriteTokens      int64    `json:"cache_creation_input_tokens"`
	CacheWriteTokensCamel int64    `json:"cacheCreationInputTokens"`
	CacheWriteShort       int64    `json:"cacheWriteTokens"`
	ReasoningTokens       int64    `json:"reasoning_tokens"`
	ReasoningTokensCamel  int64    `json:"reasoningTokens"`
	CostUSD               *float64 `json:"cost_usd"`
	CostUSDCamel          *float64 `json:"costUSD"`
	ContextWindow         int64    `json:"contextWindow"`
	ContextWindowSnake    int64    `json:"context_window"`
}

func (m modelUsageEntry) toTotals() TokenTotals {
	in := max(m.InputTokens, m.InputTokensCamel)
	out := max(m.OutputTokens, m.OutputTokensCamel)
	cr := max(m.CacheReadTokens, max(m.CacheReadTokensCamel, m.CacheReadShort))
	cw := max(m.CacheWriteTokens, max(m.CacheWriteTokensCamel, m.CacheWriteShort))
	rs := max(m.ReasoningTokens, m.ReasoningTokensCamel)
	var costMicros *int64
	if m.CostUSD != nil {
		v := int64(math.Round(*m.CostUSD * 1_000_000))
		costMicros = &v
	} else if m.CostUSDCamel != nil {
		v := int64(math.Round(*m.CostUSDCamel * 1_000_000))
		costMicros = &v
	}
	return TokenTotals{
		InputTokens:      in,
		OutputTokens:     out,
		CacheReadTokens:  cr,
		CacheWriteTokens: cw,
		ReasoningTokens:  rs,
		CostMicros:       costMicros,
	}
}

type streamJSONSession struct {
	cfg     streamJSONConfig
	opts    SessionOptions
	proc    Process
	secrets *secretDir
	stream  *recordStream
	queue   inputQueue

	writeMu sync.Mutex

	ctrlMu      sync.Mutex
	pendingCtrl map[string]chan controlReply
	nextReqID   atomic.Int64

	stateMu          sync.Mutex
	activeTurn       bool
	activeSpanID     string
	compacting       bool
	exited           bool
	disposed         bool
	resumed          bool
	baselineKnown    bool
	baselineReason   string
	baselineByModel  map[string]TokenTotals
	baselineFlat     *TokenTotals
	accumulatedUsage *TokenTotals
	lastUsage        *TokenTotals
	latestCtxTokens  int64
	toolPaths        map[string][]string
	streamedMsgIDs   map[string]bool
	pendingToolInput map[int]*partialToolBlock

	doneOnce sync.Once
	doneCh   chan struct{}
	waitErr  error
	drainWG  sync.WaitGroup

	disposeOnce sync.Once
	disposeErr  error
}

type controlReply struct {
	ok       bool
	errMsg   string
	response json.RawMessage
}

type partialToolBlock struct {
	id   string
	name string
	buf  strings.Builder
}

func startStreamJSONSession(ctx context.Context, cfg streamJSONConfig, spec LaunchSpec, opts SessionOptions, secrets *secretDir) (*streamJSONSession, error) {
	proc, err := opts.launcher().Launch(ctx, spec)
	if err != nil {
		if secrets != nil {
			secrets.close()
		}
		return nil, err
	}

	initialID := opts.ResumeSessionID
	if initialID == "" {
		initialID = fmt.Sprintf("%s-pending", cfg.runtimeID)
	}

	s := &streamJSONSession{
		cfg:              cfg,
		opts:             opts,
		proc:             proc,
		secrets:          secrets,
		stream:           newRecordStream(initialID, opts.nowMillis),
		pendingCtrl:      make(map[string]chan controlReply),
		resumed:          opts.ResumeSessionID != "",
		baselineByModel:  make(map[string]TokenTotals),
		toolPaths:        make(map[string][]string),
		streamedMsgIDs:   make(map[string]bool),
		pendingToolInput: make(map[int]*partialToolBlock),
		doneCh:           make(chan struct{}),
	}

	go s.drainStderr()
	go s.readStdout()

	if cfg.sendInitializeFirst {
		reqCtx, cancel := context.WithTimeout(ctx, opts.requestTimeout())
		_, initErr := s.sendControl(reqCtx, "initialize", cfg.initializePayload)
		cancel()
		if initErr != nil {
			_ = s.Dispose(context.Background())
			return nil, fmt.Errorf("oar: %s initialize failed: %w", cfg.runtimeID, initErr)
		}
	}

	if s.resumed && cfg.probeUsageOnResume {
		probeCtx, cancel := context.WithTimeout(ctx, opts.baselineTimeout())
		resp, err := s.sendControl(probeCtx, "get_usage", nil)
		cancel()
		if err != nil {
			s.stateMu.Lock()
			s.baselineKnown = false
			s.baselineReason = "resume_baseline_timeout"
			s.stateMu.Unlock()
		} else {
			s.captureResumeBaseline(resp)
		}
	}

	return s, nil
}

func (s *streamJSONSession) ID() string      { return s.stream.sessionIDSnapshot() }
func (s *streamJSONSession) Runtime() string { return s.cfg.runtimeID }

func (s *streamJSONSession) Records() []RecordEnvelope {
	return s.stream.recordsSnapshot()
}

func (s *streamJSONSession) Subscribe(afterSeq int64, fn func(RecordEnvelope)) func() {
	return s.stream.subscribe(afterSeq, fn)
}

func (s *streamJSONSession) Usage() *TokenTotals {
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	return s.lastUsage.Clone()
}

func (s *streamJSONSession) Wait(ctx context.Context) error {
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-s.doneCh:
		return s.waitErr
	}
}

func (s *streamJSONSession) Dispose(ctx context.Context) error {
	s.disposeOnce.Do(func() {
		s.stateMu.Lock()
		s.disposed = true
		s.stateMu.Unlock()
		s.queue.clear()
		s.failAllPendingCtrl("session disposed")
		_ = s.proc.Close()
		<-s.doneCh
		s.drainWG.Wait()
		s.stream.closeSubscribers()
		if s.secrets != nil {
			s.secrets.close()
		}
	})
	return s.disposeErr
}

func (s *streamJSONSession) Control(ctx context.Context, action ControlAction, arg string, opts ...InputOption) (ControlOutcome, error) {
	return dispatchControl(ctx, s, action, arg, opts...)
}

func (s *streamJSONSession) Prompt(ctx context.Context, input string, opts ...InputOption) (ControlOutcome, error) {
	if err := ctx.Err(); err != nil {
		return ControlOutcome{}, err
	}
	inOpts := resolveInputOptions(opts)

	s.stateMu.Lock()
	if s.exited || s.disposed {
		s.stateMu.Unlock()
		out := controlNotRunning(ControlPrompt, "session exited")
		controlOutcomeRecord(s.stream, ControlPrompt, inOpts.InputID, "", out)
		return out, nil
	}
	if s.activeTurn || s.compacting {
		s.stateMu.Unlock()
		out := ControlOutcome{
			Action:  ControlPrompt,
			Status:  ControlRejected,
			Code:    "busy",
			Reason:  "a turn or compaction is already active",
			InputID: inOpts.InputID,
		}
		controlOutcomeRecord(s.stream, ControlPrompt, inOpts.InputID, "", out)
		return out, nil
	}
	spanID := inOpts.SpanID
	if spanID == "" {
		spanID = fmt.Sprintf("turn-%d", s.nextReqID.Add(1))
	}
	s.activeTurn = true
	s.activeSpanID = spanID
	s.stateMu.Unlock()

	// Emit turn_started before writing stdin so fast responders never race turn_ended ahead of turn_started.
	s.stream.emit(RecordFrame, spanID, []string{}, "user_prompt", nil, []Event{{Kind: EventTurnStarted, Input: input, RequestID: inOpts.InputID}}, nil, nil)
	if err := s.dispatchUserFrame(input, spanID); err != nil {
		s.stateMu.Lock()
		s.activeTurn = false
		s.activeSpanID = ""
		s.stateMu.Unlock()
		return ControlOutcome{}, err
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

func (s *streamJSONSession) Steer(ctx context.Context, input string, opts ...InputOption) (ControlOutcome, error) {
	if err := ctx.Err(); err != nil {
		return ControlOutcome{}, err
	}
	inOpts := resolveInputOptions(opts)

	if !s.cfg.supportsSteer {
		out := ControlOutcome{
			Action:  ControlSteer,
			Status:  ControlUnsupported,
			Code:    "unsupported",
			Reason:  fmt.Sprintf("%s does not support mid-turn steer", s.cfg.runtimeID),
			InputID: inOpts.InputID,
		}
		controlOutcomeRecord(s.stream, ControlSteer, inOpts.InputID, "", out)
		return out, nil
	}

	s.stateMu.Lock()
	if s.exited || s.disposed {
		s.stateMu.Unlock()
		out := controlNotRunning(ControlSteer, "session exited")
		controlOutcomeRecord(s.stream, ControlSteer, inOpts.InputID, "", out)
		return out, nil
	}
	if !s.activeTurn {
		s.stateMu.Unlock()
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
	spanID := s.activeSpanID
	s.stateMu.Unlock()

	if err := s.dispatchUserFrame(input, spanID); err != nil {
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

func (s *streamJSONSession) Queue(ctx context.Context, input string, opts ...InputOption) (ControlOutcome, error) {
	if err := ctx.Err(); err != nil {
		return ControlOutcome{}, err
	}
	inOpts := resolveInputOptions(opts)

	s.stateMu.Lock()
	if s.exited || s.disposed {
		s.stateMu.Unlock()
		out := controlNotRunning(ControlQueue, "session exited")
		controlOutcomeRecord(s.stream, ControlQueue, inOpts.InputID, "", out)
		return out, nil
	}
	busy := s.activeTurn || s.compacting
	s.stateMu.Unlock()

	if !busy {
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

func (s *streamJSONSession) Withdraw(ctx context.Context, inputID string) (ControlOutcome, error) {
	s.stateMu.Lock()
	stopped := s.exited || s.disposed
	s.stateMu.Unlock()
	return withdrawInput(ctx, s.stream, &s.queue, stopped, inputID)
}

func (s *streamJSONSession) Abort(ctx context.Context) (ControlOutcome, error) {
	if err := ctx.Err(); err != nil {
		return ControlOutcome{}, err
	}
	s.stateMu.Lock()
	if s.exited || s.disposed {
		s.stateMu.Unlock()
		out := controlNotRunning(ControlAbort, "session exited")
		controlOutcomeRecord(s.stream, ControlAbort, "", "", out)
		return out, nil
	}
	active := s.activeTurn || s.compacting
	spanID := s.activeSpanID
	s.stateMu.Unlock()

	if !active {
		out := ControlOutcome{
			Action: ControlAbort,
			Status: ControlRejected,
			Code:   "no_active_turn",
			Reason: "no active turn to abort",
		}
		controlOutcomeRecord(s.stream, ControlAbort, "", "", out)
		return out, nil
	}

	reqCtx, cancel := context.WithTimeout(ctx, s.opts.requestTimeout())
	_, err := s.sendControl(reqCtx, "interrupt", nil)
	cancel()
	if err != nil {
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

func (s *streamJSONSession) Compact(ctx context.Context) (ControlOutcome, error) {
	if err := ctx.Err(); err != nil {
		return ControlOutcome{}, err
	}
	if !s.cfg.supportsCompact {
		out := ControlOutcome{
			Action: ControlCompact,
			Status: ControlUnsupported,
			Code:   "unsupported",
			Reason: fmt.Sprintf("%s does not support manual compaction", s.cfg.runtimeID),
		}
		controlOutcomeRecord(s.stream, ControlCompact, "", "", out)
		return out, nil
	}
	s.stateMu.Lock()
	if s.exited || s.disposed {
		s.stateMu.Unlock()
		out := controlNotRunning(ControlCompact, "session exited")
		controlOutcomeRecord(s.stream, ControlCompact, "", "", out)
		return out, nil
	}
	if s.activeTurn || s.compacting {
		s.stateMu.Unlock()
		out := ControlOutcome{
			Action: ControlCompact,
			Status: ControlRejected,
			Code:   "busy",
			Reason: "cannot compact while turn is active",
		}
		controlOutcomeRecord(s.stream, ControlCompact, "", "", out)
		return out, nil
	}
	s.compacting = true
	spanID := fmt.Sprintf("compact-%d", s.nextReqID.Add(1))
	s.activeSpanID = spanID
	s.stateMu.Unlock()

	s.stream.emit(RecordFrame, spanID, []string{}, "compaction_started", nil, []Event{{Kind: EventCompactionStarted, Trigger: "manual"}}, nil, nil)
	if err := s.dispatchUserFrame("/compact", spanID); err != nil {
		s.stateMu.Lock()
		s.compacting = false
		s.activeSpanID = ""
		s.stateMu.Unlock()
		return ControlOutcome{}, err
	}
	out := ControlOutcome{
		Action: ControlCompact,
		Status: ControlAccepted,
		SpanID: spanID,
	}
	controlOutcomeRecord(s.stream, ControlCompact, "", "", out)
	return out, nil
}

func (s *streamJSONSession) StopTask(ctx context.Context, taskID string) (ControlOutcome, error) {
	if err := ctx.Err(); err != nil {
		return ControlOutcome{}, err
	}
	if !s.cfg.supportsStopTask {
		out := ControlOutcome{
			Action: ControlStopTask,
			Status: ControlUnsupported,
			Code:   "unsupported",
			Reason: fmt.Sprintf("%s does not support stop_task", s.cfg.runtimeID),
		}
		controlOutcomeRecord(s.stream, ControlStopTask, "", taskID, out)
		return out, nil
	}
	if strings.TrimSpace(taskID) == "" {
		out := ControlOutcome{
			Action: ControlStopTask,
			Status: ControlRejected,
			Code:   "invalid_task_id",
			Reason: "taskId must not be empty",
		}
		controlOutcomeRecord(s.stream, ControlStopTask, "", taskID, out)
		return out, nil
	}
	s.stateMu.Lock()
	stopped := s.exited || s.disposed
	s.stateMu.Unlock()
	if stopped {
		out := controlNotRunning(ControlStopTask, "session exited")
		controlOutcomeRecord(s.stream, ControlStopTask, "", taskID, out)
		return out, nil
	}

	reqCtx, cancel := context.WithTimeout(ctx, s.opts.requestTimeout())
	_, err := s.sendControl(reqCtx, "stop_task", map[string]any{"task_id": taskID})
	cancel()
	if err != nil {
		out := ControlOutcome{
			Action: ControlStopTask,
			Status: ControlRejected,
			Code:   "stop_task_failed",
			Reason: err.Error(),
		}
		controlOutcomeRecord(s.stream, ControlStopTask, "", taskID, out)
		return out, nil
	}
	out := ControlOutcome{
		Action: ControlStopTask,
		Status: ControlAccepted,
	}
	controlOutcomeRecord(s.stream, ControlStopTask, "", taskID, out)
	return out, nil
}

func (s *streamJSONSession) dispatchUserFrame(input, spanID string) error {
	payload := map[string]any{
		"type":       "user",
		"session_id": s.ID(),
		"message": map[string]any{
			"role":    "user",
			"content": input,
		},
	}
	if spanID != "" {
		payload["uuid"] = spanID
	}
	return writeJSONLine(&s.writeMu, s.proc.Stdin(), payload)
}

func (s *streamJSONSession) sendControl(ctx context.Context, subtype string, extra map[string]any) (json.RawMessage, error) {
	reqID := fmt.Sprintf("req-%d", s.nextReqID.Add(1))
	ch := make(chan controlReply, 1)

	s.ctrlMu.Lock()
	s.pendingCtrl[reqID] = ch
	s.ctrlMu.Unlock()

	reqBody := map[string]any{"subtype": subtype}
	for k, v := range extra {
		reqBody[k] = v
	}
	frame := map[string]any{
		"type":       "control_request",
		"request_id": reqID,
		"request":    reqBody,
	}
	if err := writeJSONLine(&s.writeMu, s.proc.Stdin(), frame); err != nil {
		s.ctrlMu.Lock()
		delete(s.pendingCtrl, reqID)
		s.ctrlMu.Unlock()
		return nil, err
	}

	select {
	case <-ctx.Done():
		s.ctrlMu.Lock()
		delete(s.pendingCtrl, reqID)
		s.ctrlMu.Unlock()
		return nil, ctx.Err()
	case rep := <-ch:
		if !rep.ok {
			if rep.errMsg == "" {
				return nil, fmt.Errorf("control %s rejected", subtype)
			}
			return nil, errors.New(rep.errMsg)
		}
		return rep.response, nil
	}
}

func (s *streamJSONSession) failAllPendingCtrl(reason string) {
	s.ctrlMu.Lock()
	for id, ch := range s.pendingCtrl {
		ch <- controlReply{ok: false, errMsg: reason}
		delete(s.pendingCtrl, id)
	}
	s.ctrlMu.Unlock()
}

func (s *streamJSONSession) drainStderr() {
	_, _ = io.Copy(io.Discard, s.proc.Stderr())
}

func (s *streamJSONSession) readStdout() {
	defer close(s.doneCh)
	readErr := readNDJSONLines(s.proc.Stdout(), func(raw []byte) error {
		s.handleFrame(raw)
		return nil
	})
	exitStat, waitErr := s.proc.Wait()

	s.stateMu.Lock()
	s.exited = true
	wasTurn := s.activeTurn
	wasCompacting := s.compacting
	spanID := s.activeSpanID
	disposed := s.disposed
	s.activeTurn = false
	s.compacting = false
	s.activeSpanID = ""
	s.stateMu.Unlock()

	s.failAllPendingCtrl("process exited")
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
				Reason:  fmt.Sprintf("%s exited unexpectedly (code %d)", s.cfg.runtimeID, exitStat.Code),
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
}

func (s *streamJSONSession) handleFrame(raw []byte) {
	var envelope struct {
		Type            string          `json:"type"`
		Subtype         string          `json:"subtype"`
		SessionID       string          `json:"session_id"`
		SessionIDCamel  string          `json:"sessionId"`
		ParentToolUseID string          `json:"parent_tool_use_id"`
		Model           string          `json:"model"`
		Status          string          `json:"status"`
		TaskID          string          `json:"task_id"`
		TaskType        string          `json:"task_type"`
		Description     string          `json:"description"`
		Summary         string          `json:"summary"`
		IsError         bool            `json:"is_error"`
		Result          string          `json:"result"`
		TotalCostUSD    *float64        `json:"total_cost_usd"`
		CostUSD         *float64        `json:"costUSD"`
		Event           json.RawMessage `json:"event"`
		Message         json.RawMessage `json:"message"`
		Response        json.RawMessage `json:"response"`
		ModelUsage      json.RawMessage `json:"modelUsage"`
		ModelUsageSnake json.RawMessage `json:"model_usage"`
		Usage           json.RawMessage `json:"usage"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return
	}

	if envelope.SessionID != "" {
		s.stream.setSessionID(envelope.SessionID)
	} else if envelope.SessionIDCamel != "" {
		s.stream.setSessionID(envelope.SessionIDCamel)
	}

	if envelope.Type == "control_response" {
		s.resolveControlResponse(raw, envelope.Response)
		return
	}

	agentPath := s.resolveAgentPath(envelope.ParentToolUseID)
	s.stateMu.Lock()
	spanID := s.activeSpanID
	s.stateMu.Unlock()

	var events []Event
	frameType := envelope.Type
	if envelope.Subtype != "" {
		frameType = envelope.Type + "/" + envelope.Subtype
	}

	switch envelope.Type {
	case "system":
		switch envelope.Subtype {
		case "init":
			if envelope.Model != "" {
				events = append(events, Event{Kind: EventModel, Model: envelope.Model})
			}
		case "status":
			if envelope.Status == "compacting" {
				s.stateMu.Lock()
				already := s.compacting
				s.compacting = true
				s.stateMu.Unlock()
				if !already {
					events = append(events, Event{Kind: EventCompactionStarted, Trigger: "auto"})
				}
			}
		case "compact_boundary":
			s.stateMu.Lock()
			s.compacting = false
			s.stateMu.Unlock()
			events = append(events, Event{Kind: EventCompactionEnded, CompactionOutcome: "completed"})
		case "task_started":
			kind := envelope.TaskType
			if kind == "local_agent" {
				kind = "agent"
			}
			events = append(events, Event{
				Kind:     EventTaskStarted,
				TaskID:   envelope.TaskID,
				TaskKind: kind,
				Label:    envelope.Description,
			})
		case "task_progress":
			events = append(events, Event{
				Kind:    EventTaskUpdated,
				TaskID:  envelope.TaskID,
				Status:  "running",
				Summary: envelope.Description,
			})
		case "task_notification":
			st := envelope.Status
			if st == "killed" {
				st = "stopped"
			}
			events = append(events, Event{
				Kind:    EventTaskEnded,
				TaskID:  envelope.TaskID,
				Status:  st,
				Summary: envelope.Summary,
			})
		}

	case "stream_event":
		events = append(events, s.handleStreamEvent(envelope.Event, agentPath)...)

	case "assistant":
		events = append(events, s.handleAssistantMessage(envelope.Message, agentPath)...)

	case "user":
		events = append(events, s.handleUserToolResults(envelope.Message)...)

	case "result":
		usageReport := s.computeResultUsage(envelope.ModelUsage, envelope.ModelUsageSnake, envelope.Usage, envelope.TotalCostUSD, envelope.CostUSD)
		outcome := s.resultOutcome(envelope.Subtype, envelope.IsError, envelope.Result)

		s.stateMu.Lock()
		wasCompacting := s.compacting
		s.compacting = false
		s.activeTurn = false
		s.activeSpanID = ""
		if usageReport.Tokens != nil {
			cp := usageReport.Tokens.Clone()
			s.lastUsage = cp
		} else {
			s.lastUsage = nil
		}
		s.stateMu.Unlock()

		if wasCompacting {
			compOutcome := "completed"
			if outcome.Kind == "aborted" {
				compOutcome = "aborted"
			} else if outcome.Kind == "failed" {
				compOutcome = "failed"
			}
			events = append(events, Event{Kind: EventCompactionEnded, CompactionOutcome: compOutcome})
		} else {
			events = append(events, Event{Kind: EventTurnEnded, Outcome: &outcome})
		}
		events = append(events, Event{Kind: EventUsage, Usage: &usageReport})
	}

	s.stream.emit(RecordFrame, spanID, agentPath, frameType, raw, events, nil, nil)

	if envelope.Type == "result" {
		s.drainNextQueued()
	}
}

func (s *streamJSONSession) resolveControlResponse(raw, inner json.RawMessage) {
	var resp struct {
		Subtype   string          `json:"subtype"`
		RequestID string          `json:"request_id"`
		Error     string          `json:"error"`
		Response  json.RawMessage `json:"response"`
	}
	if len(inner) > 0 {
		_ = json.Unmarshal(inner, &resp)
	}
	if resp.RequestID == "" {
		var top struct {
			RequestID string          `json:"request_id"`
			Subtype   string          `json:"subtype"`
			Error     string          `json:"error"`
			Response  json.RawMessage `json:"response"`
		}
		_ = json.Unmarshal(raw, &top)
		resp.RequestID = top.RequestID
		if resp.Subtype == "" {
			resp.Subtype = top.Subtype
		}
		if resp.Error == "" {
			resp.Error = top.Error
		}
		if len(resp.Response) == 0 {
			resp.Response = top.Response
		}
	}

	s.ctrlMu.Lock()
	ch := s.pendingCtrl[resp.RequestID]
	delete(s.pendingCtrl, resp.RequestID)
	s.ctrlMu.Unlock()
	if ch == nil {
		return
	}
	ok := resp.Subtype != "error" && resp.Error == ""
	ch <- controlReply{
		ok:       ok,
		errMsg:   resp.Error,
		response: resp.Response,
	}
}

func (s *streamJSONSession) resolveAgentPath(parentToolUseID string) []string {
	if parentToolUseID == "" {
		return []string{}
	}
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	if path, ok := s.toolPaths[parentToolUseID]; ok {
		return append([]string(nil), path...)
	}
	return []string{parentToolUseID}
}

func (s *streamJSONSession) registerToolPath(parentPath []string, callID string) {
	if callID == "" {
		return
	}
	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	next := make([]string, len(parentPath)+1)
	copy(next, parentPath)
	next[len(parentPath)] = callID
	s.toolPaths[callID] = next
}

func (s *streamJSONSession) handleStreamEvent(raw json.RawMessage, agentPath []string) []Event {
	var ev struct {
		Type    string `json:"type"`
		Index   int    `json:"index"`
		Message struct {
			ID string `json:"id"`
		} `json:"message"`
		ContentBlock struct {
			Type  string          `json:"type"`
			ID    string          `json:"id"`
			Name  string          `json:"name"`
			Text  string          `json:"text"`
			Input json.RawMessage `json:"input"`
		} `json:"content_block"`
		Delta struct {
			Type        string `json:"type"`
			Text        string `json:"text"`
			Thinking    string `json:"thinking"`
			PartialJSON string `json:"partial_json"`
		} `json:"delta"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &ev) != nil {
		return nil
	}

	var out []Event
	switch ev.Type {
	case "message_start":
		if ev.Message.ID != "" {
			s.stateMu.Lock()
			s.streamedMsgIDs[ev.Message.ID] = true
			s.stateMu.Unlock()
		}
	case "content_block_start":
		switch ev.ContentBlock.Type {
		case "tool_use":
			s.registerToolPath(agentPath, ev.ContentBlock.ID)
			s.stateMu.Lock()
			s.pendingToolInput[ev.Index] = &partialToolBlock{
				id:   ev.ContentBlock.ID,
				name: ev.ContentBlock.Name,
			}
			s.stateMu.Unlock()
			out = append(out, Event{
				Kind:   EventToolCallStarted,
				CallID: ev.ContentBlock.ID,
				Tool:   ev.ContentBlock.Name,
			})
		}
	case "content_block_delta":
		switch ev.Delta.Type {
		case "text_delta":
			if ev.Delta.Text != "" {
				out = append(out, Event{Kind: EventTextDelta, Text: ev.Delta.Text})
			}
		case "thinking_delta":
			if ev.Delta.Thinking != "" {
				out = append(out, Event{Kind: EventReasoning, ReasoningKind: "text", Text: ev.Delta.Thinking})
			}
		case "input_json_delta":
			s.stateMu.Lock()
			if blk := s.pendingToolInput[ev.Index]; blk != nil {
				blk.buf.WriteString(ev.Delta.PartialJSON)
			}
			s.stateMu.Unlock()
		}
	case "content_block_stop":
		s.stateMu.Lock()
		blk := s.pendingToolInput[ev.Index]
		delete(s.pendingToolInput, ev.Index)
		s.stateMu.Unlock()
		if blk != nil && blk.buf.Len() > 0 {
			out = append(out, Event{
				Kind:   EventToolCallInput,
				CallID: blk.id,
				Input:  blk.buf.String(),
			})
		}
	}
	return out
}

func (s *streamJSONSession) handleAssistantMessage(raw json.RawMessage, agentPath []string) []Event {
	var msg struct {
		ID      string          `json:"id"`
		Model   string          `json:"model"`
		Usage   json.RawMessage `json:"usage"`
		Content []struct {
			Type     string          `json:"type"`
			Text     string          `json:"text"`
			Thinking string          `json:"thinking"`
			ID       string          `json:"id"`
			Name     string          `json:"name"`
			Input    json.RawMessage `json:"input"`
		} `json:"content"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &msg) != nil {
		return nil
	}

	s.stateMu.Lock()
	alreadyStreamed := msg.ID != "" && s.streamedMsgIDs[msg.ID]
	if len(msg.Usage) > 0 {
		var u modelUsageEntry
		if json.Unmarshal(msg.Usage, &u) == nil {
			t := u.toTotals()
			if t.InputTokens > 0 || t.CacheReadTokens > 0 || t.OutputTokens > 0 {
				s.latestCtxTokens = t.InputTokens + t.CacheReadTokens + t.OutputTokens
			}
		}
	}
	s.stateMu.Unlock()

	var out []Event
	if msg.Model != "" {
		out = append(out, Event{Kind: EventModel, Model: msg.Model})
	}
	for _, blk := range msg.Content {
		switch blk.Type {
		case "thinking":
			if !alreadyStreamed && blk.Thinking != "" {
				out = append(out, Event{Kind: EventReasoning, ReasoningKind: "text", Text: blk.Thinking})
			}
		case "text":
			if !alreadyStreamed && blk.Text != "" {
				out = append(out, Event{Kind: EventTextDelta, Text: blk.Text})
			}
		case "tool_use":
			s.registerToolPath(agentPath, blk.ID)
			inputStr := strings.TrimSpace(string(blk.Input))
			if !alreadyStreamed {
				out = append(out, Event{
					Kind:   EventToolCallStarted,
					CallID: blk.ID,
					Tool:   blk.Name,
					Input:  inputStr,
				})
			} else if inputStr != "" && inputStr != "{}" {
				out = append(out, Event{
					Kind:   EventToolCallInput,
					CallID: blk.ID,
					Input:  inputStr,
				})
			}
		}
	}
	return out
}

func (s *streamJSONSession) handleUserToolResults(raw json.RawMessage) []Event {
	var msg struct {
		Content []struct {
			Type      string          `json:"type"`
			ToolUseID string          `json:"tool_use_id"`
			IsError   bool            `json:"is_error"`
			Content   json.RawMessage `json:"content"`
		} `json:"content"`
	}
	if len(raw) == 0 || json.Unmarshal(raw, &msg) != nil {
		return nil
	}
	var out []Event
	for _, blk := range msg.Content {
		if blk.Type != "tool_result" {
			continue
		}
		res := "ok"
		if blk.IsError {
			res = "failed"
		}
		out = append(out, Event{
			Kind:    EventToolCallEnded,
			CallID:  blk.ToolUseID,
			Result:  res,
			Content: parseToolResultContent(blk.Content),
		})
	}
	return out
}

func parseToolResultContent(raw json.RawMessage) []ToolOutputPart {
	if len(raw) == 0 {
		return nil
	}
	var text string
	if json.Unmarshal(raw, &text) == nil {
		if text == "" {
			return nil
		}
		return []ToolOutputPart{{Type: "text", Text: text}}
	}
	var parts []struct {
		Type string `json:"type"`
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &parts) == nil {
		var out []ToolOutputPart
		for _, p := range parts {
			switch p.Type {
			case "text":
				if p.Text != "" {
					out = append(out, ToolOutputPart{Type: "text", Text: p.Text})
				}
			case "image":
				out = append(out, ToolOutputPart{Type: "image"})
			}
		}
		return out
	}
	return nil
}

func (s *streamJSONSession) captureResumeBaseline(resp json.RawMessage) {
	if len(resp) == 0 {
		s.stateMu.Lock()
		s.baselineKnown = false
		s.baselineReason = "empty_resume_baseline"
		s.stateMu.Unlock()
		return
	}

	var parsed struct {
		ModelUsageSnake map[string]modelUsageEntry `json:"model_usage"`
		ModelUsageCamel map[string]modelUsageEntry `json:"modelUsage"`
		Usage           json.RawMessage            `json:"usage"`
	}
	if json.Unmarshal(resp, &parsed) != nil {
		s.stateMu.Lock()
		s.baselineKnown = false
		s.baselineReason = "malformed_resume_baseline"
		s.stateMu.Unlock()
		return
	}

	byModel := parsed.ModelUsageSnake
	if len(byModel) == 0 {
		byModel = parsed.ModelUsageCamel
	}

	s.stateMu.Lock()
	defer s.stateMu.Unlock()
	if len(byModel) > 0 {
		for model, entry := range byModel {
			s.baselineByModel[model] = entry.toTotals()
		}
		s.baselineKnown = true
		return
	}
	if len(parsed.Usage) > 0 {
		var u modelUsageEntry
		if json.Unmarshal(parsed.Usage, &u) == nil {
			t := u.toTotals()
			s.baselineFlat = &t
			s.baselineKnown = true
			return
		}
	}
	s.baselineKnown = false
	s.baselineReason = "missing_resume_usage_fields"
}

func (s *streamJSONSession) computeResultUsage(modelUsageCamel, modelUsageSnake, flatUsage json.RawMessage, totalCostSnake, totalCostCamel *float64) UsageReport {
	s.stateMu.Lock()
	resumed := s.resumed
	baselineKnown := s.baselineKnown
	baselineReason := s.baselineReason
	baselineByModel := s.baselineByModel
	baselineFlat := s.baselineFlat
	ctxTokens := s.latestCtxTokens
	s.stateMu.Unlock()

	var byModel map[string]modelUsageEntry
	if len(modelUsageCamel) > 0 {
		_ = json.Unmarshal(modelUsageCamel, &byModel)
	}
	if len(byModel) == 0 && len(modelUsageSnake) > 0 {
		_ = json.Unmarshal(modelUsageSnake, &byModel)
	}

	var ctxReport *ContextUsage
	if len(byModel) > 0 {
		var maxWindow int64
		for _, m := range byModel {
			if w := max(m.ContextWindow, m.ContextWindowSnake); w > maxWindow {
				maxWindow = w
			}
		}
		if maxWindow > 0 && ctxTokens > 0 {
			ctxReport = &ContextUsage{
				Tokens:        ctxTokens,
				ContextWindow: maxWindow,
				Percent:       (float64(ctxTokens) / float64(maxWindow)) * 100,
			}
		}
	}

	// Honest accounting: on a resumed session where cumulative totals require a baseline
	// and the baseline failed or timed out, refuse to emit cumulative historical totals.
	if resumed && s.cfg.probeUsageOnResume && !baselineKnown {
		return UsageReport{
			Tokens:        nil,
			Context:       ctxReport,
			UnknownReason: baselineReason,
		}
	}

	if len(byModel) > 0 {
		if resumed && !baselineKnown {
			return UsageReport{
				Tokens:        nil,
				Context:       ctxReport,
				UnknownReason: "cumulative_usage_without_baseline",
			}
		}
		var total TokenTotals
		for model, entry := range byModel {
			cur := entry.toTotals()
			if resumed {
				if base, ok := baselineByModel[model]; ok {
					cur = cur.Subtract(base)
				}
			}
			total = total.Add(cur)
		}
		if !resumed && total.CostMicros == nil {
			if c := firstCostMicros(totalCostSnake, totalCostCamel); c != nil {
				total.CostMicros = c
			}
		}
		return UsageReport{Tokens: &total, Context: ctxReport}
	}

	if len(flatUsage) > 0 {
		var u modelUsageEntry
		if json.Unmarshal(flatUsage, &u) == nil && hasRawTokenKeys(flatUsage) {
			cur := u.toTotals()
			if cur.CostMicros == nil {
				if c := firstCostMicros(totalCostSnake, totalCostCamel); c != nil {
					cur.CostMicros = c
				}
			}
			if s.cfg.usageIsPerTurn {
				s.stateMu.Lock()
				if s.accumulatedUsage != nil {
					cur = s.accumulatedUsage.Add(cur)
				}
				cp := cur.Clone()
				s.accumulatedUsage = cp
				s.stateMu.Unlock()
				return UsageReport{Tokens: &cur, Context: ctxReport}
			}
			if resumed {
				if baselineFlat == nil {
					return UsageReport{
						Tokens:        nil,
						Context:       ctxReport,
						UnknownReason: "missing_flat_resume_baseline",
					}
				}
				cur = cur.Subtract(*baselineFlat)
			}
			return UsageReport{Tokens: &cur, Context: ctxReport}
		}
	}

	return UsageReport{
		Tokens:        nil,
		Context:       ctxReport,
		UnknownReason: "usage_not_reported",
	}
}

func firstCostMicros(a, b *float64) *int64 {
	if a != nil {
		v := int64(math.Round(*a * 1_000_000))
		return &v
	}
	if b != nil {
		v := int64(math.Round(*b * 1_000_000))
		return &v
	}
	return nil
}

func hasRawTokenKeys(raw json.RawMessage) bool {
	var m map[string]json.RawMessage
	if json.Unmarshal(raw, &m) != nil {
		return false
	}
	for _, k := range []string{"input_tokens", "inputTokens", "output_tokens", "outputTokens"} {
		if _, ok := m[k]; ok {
			return true
		}
	}
	return false
}

func (s *streamJSONSession) resultOutcome(subtype string, isError bool, result string) TurnOutcome {
	if subtype == "aborted" || subtype == "interrupted" || subtype == "cancelled" {
		return TurnOutcome{Kind: "aborted"}
	}
	if isError || strings.HasPrefix(subtype, "error") {
		return TurnOutcome{
			Kind:    "failed",
			Failure: classifyFailure(result, nil),
			Reason:  result,
		}
	}
	return TurnOutcome{Kind: "completed"}
}

func (s *streamJSONSession) drainNextQueued() {
	drainQueued(&s.queue, func() bool {
		s.stateMu.Lock()
		defer s.stateMu.Unlock()
		return !s.exited && !s.disposed && !s.activeTurn && !s.compacting
	}, s.Prompt, &s.drainWG)
}
