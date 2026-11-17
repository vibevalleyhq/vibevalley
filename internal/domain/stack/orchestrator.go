package stack

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"

	"github.com/vibevalleyhq/vibevalley/internal/durable"
	"github.com/vibevalleyhq/vibevalley/internal/durable/store"
	"github.com/vibevalleyhq/vibevalley/internal/provider"
	"github.com/vibevalleyhq/vibevalley/pkg/contract"
)

const (
	defaultOrchestratorAgentID = "orchestrator"
	defaultOrchestratorModel   = "deepseek-chat"
	defaultOpenAIBodyMaxBytes  = 1 << 20 // 1 MiB
)

var (
	// ErrOrchestratorBusy is returned when Send is invoked while an active turn is still running on the conversation.
	ErrOrchestratorBusy = errors.New("stack: orchestrator conversation is busy")
)

// OrchestratorConfig configures an Orchestrator service layered over Stack.
type OrchestratorConfig struct {
	AgentID          string
	DefaultModel     string
	ProviderAffinity string
	SystemPrompt     string
	Model            durable.ModelClient
	Tools            *DomainToolRegistry
	MaxBodyBytes     int64
	SettingsLookup   SettingsLookup
	HTTPClient       *http.Client
	Getenv           func(string) string
	StrictKeys       bool
}

// OpenOptions configures opening or resetting an orchestrator durable conversation.
type OpenOptions struct {
	ConversationID   string `json:"conversationId,omitempty"`
	AgentID          string `json:"agentId,omitempty"`
	ProviderAffinity string `json:"providerAffinity,omitempty"`
	SystemPrompt     string `json:"systemPrompt,omitempty"`
	ChannelID        string `json:"channelId,omitempty"`
	Reset            bool   `json:"reset,omitempty"`
}

// SendRequest submits a user or platform message to an orchestrator conversation.
type SendRequest struct {
	ConversationID string             `json:"conversationId,omitempty"`
	AgentID        string             `json:"agentId,omitempty"`
	ChannelID      string             `json:"channelId,omitempty"`
	UserID         string             `json:"userId,omitempty"`
	Text           string             `json:"text"`
	Source         string             `json:"source,omitempty"`
	RequestID      string             `json:"requestId,omitempty"`
	IncludeContext bool               `json:"includeContext,omitempty"`
	Wait           bool               `json:"wait,omitempty"`
	OnDelta        func(chunk string) `json:"-"`
}

// SendResult reports the scheduled or completed turn outcome.
type SendResult struct {
	ConversationID string     `json:"conversationId"`
	TaskID         string     `json:"taskId"`
	SubmissionID   string     `json:"submissionId,omitempty"`
	Status         string     `json:"status"`
	Output         string     `json:"output,omitempty"`
	ErrorText      string     `json:"errorText,omitempty"`
	Task           store.Task `json:"task"`
}

// ConversationState summarizes the durable state of an orchestrator conversation.
type ConversationState struct {
	ConversationID   string                   `json:"conversationId"`
	AgentID          string                   `json:"agentId"`
	ProviderAffinity string                   `json:"providerAffinity,omitempty"`
	Exists           bool                     `json:"exists"`
	Active           bool                     `json:"active"`
	ActiveTaskID     string                   `json:"activeTaskId,omitempty"`
	ActiveStatus     store.TaskStatus         `json:"activeStatus,omitempty"`
	EntryCount       int                      `json:"entryCount"`
	HeadSeq          int64                    `json:"headSeq"`
	Budget           *contract.BudgetSnapshot `json:"budget,omitempty"`
	LastOutput       string                   `json:"lastOutput,omitempty"`
	Tasks            []store.Task             `json:"tasks,omitempty"`
}

// Orchestrator manages VibeValley assistant conversations backed by Stack's durable Store and Scheduler.
type Orchestrator struct {
	stack *Stack
	cfg   OrchestratorConfig
	model durable.ModelClient
	tools *DomainToolRegistry

	streamMu    sync.RWMutex
	streamHooks map[string]func(chunk string)
}

// NewOrchestrator constructs an Orchestrator service over s, wiring real LLM routing and domain tools
// when s was initialized without custom overrides.
func NewOrchestrator(s *Stack, cfgs ...OrchestratorConfig) (*Orchestrator, error) {
	if s == nil {
		return nil, fmt.Errorf("%w: stack is required", ErrInvalidConfig)
	}
	if s.closed.Load() {
		return nil, ErrClosed
	}

	var cfg OrchestratorConfig
	if len(cfgs) > 0 {
		cfg = cfgs[0]
	}
	if strings.TrimSpace(cfg.AgentID) == "" {
		cfg.AgentID = defaultOrchestratorAgentID
	}
	if strings.TrimSpace(cfg.DefaultModel) == "" {
		cfg.DefaultModel = defaultOrchestratorModel
	}
	if strings.TrimSpace(cfg.SystemPrompt) == "" {
		cfg.SystemPrompt = OrchestratorSystemPrompt
	}
	if cfg.MaxBodyBytes <= 0 {
		cfg.MaxBodyBytes = defaultOpenAIBodyMaxBytes
	}

	tools := cfg.Tools
	if tools == nil {
		tools = NewDomainToolRegistry(s)
	}

	o := &Orchestrator{
		stack:       s,
		cfg:         cfg,
		tools:       tools,
		streamHooks: make(map[string]func(chunk string)),
	}

	var baseModel durable.ModelClient
	switch {
	case cfg.Model != nil:
		baseModel = cfg.Model
	case s.cfg.Model != nil:
		baseModel = s.model
	default:
		baseModel = NewModelClient(ModelClientDeps{
			Vault:          s.Vault,
			HTTPClient:     cfg.HTTPClient,
			Getenv:         cfg.Getenv,
			SettingsLookup: cfg.SettingsLookup,
			DefaultModel:   cfg.DefaultModel,
			SystemPrompt:   cfg.SystemPrompt,
			StrictKeys:     cfg.StrictKeys,
		})
	}
	o.model = &orchestratorStreamModel{
		orch: o,
		base: baseModel,
	}

	// Wire durable generation & codemode phases so orchestrator stream hooks capture live deltas
	// while preserving any custom Model or ToolExecutor configured on Stack.
	exec := s.tools
	if cfg.Tools != nil || s.cfg.Tools == nil {
		exec = s.wrapToolExecutor(tools.Executor())
	}
	durable.RegisterGenerationPhases(s.Scheduler, durable.GenerationDeps{
		Store:        s.Store,
		Model:        o.model,
		Tools:        exec,
		Compactor:    s.Compactor,
		Budget:       s.Budget,
		Permissions:  s.Permissions,
		Grader:       s.Grader,
		Deliverables: s.Deliverables,
	})
	if s.cfg.CodeTool == nil {
		durable.RegisterCodeModePhases(s.Scheduler, tools.CodeToolFunc())
	}

	return o, nil
}

// DefaultConversationID returns the canonical durable conversation ID for this orchestrator.
func (o *Orchestrator) DefaultConversationID() string {
	return "orch-" + o.cfg.AgentID
}

// Tools returns the DomainToolRegistry attached to this Orchestrator.
func (o *Orchestrator) Tools() *DomainToolRegistry {
	return o.tools
}

// Open opens an existing orchestrator conversation or creates and initializes a new one.
func (o *Orchestrator) Open(ctx context.Context, opts OpenOptions) (ConversationState, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if o.stack.closed.Load() {
		return ConversationState{}, ErrClosed
	}

	agentID := firstNonEmpty(opts.AgentID, o.cfg.AgentID)
	convID := firstNonEmpty(opts.ConversationID, "orch-"+agentID)
	affinity := strings.TrimSpace(opts.ProviderAffinity)
	if affinity == "" {
		affinity = strings.TrimSpace(o.cfg.ProviderAffinity)
	}
	if affinity == "" && o.stack.Agents != nil {
		if prof, err := o.stack.Agents.GetProfile(ctx, agentID); err == nil && strings.TrimSpace(prof.Model) != "" {
			affinity = strings.TrimSpace(prof.Model)
		}
	}
	if affinity == "" {
		affinity = o.cfg.DefaultModel
	}

	sysPrompt := strings.TrimSpace(opts.SystemPrompt)
	if sysPrompt == "" {
		sysPrompt = o.cfg.SystemPrompt
		if o.stack.Agents != nil {
			if prof, err := o.stack.Agents.GetProfile(ctx, agentID); err == nil && (prof.Name != "" || prof.Persona != "") {
				sysPrompt = BuildOrchestratorPrompt(OrchestratorPromptOptions{
					Name:    prof.Name,
					Persona: prof.Persona,
				})
			}
		}
	}

	_, err := o.stack.Store.GetConversation(ctx, convID)
	if errors.Is(err, store.ErrNotFound) {
		if _, cErr := o.stack.Store.CreateConversation(ctx, store.Conversation{
			ID:               convID,
			ProviderAffinity: affinity,
		}); cErr != nil && !errors.Is(cErr, store.ErrDuplicate) {
			return ConversationState{}, cErr
		}
		if err := o.appendSystemAndDoc(ctx, convID, agentID, opts.ChannelID, sysPrompt); err != nil {
			return ConversationState{}, err
		}
	} else if err != nil {
		return ConversationState{}, err
	} else if opts.Reset {
		if _, rErr := o.stack.Store.AppendReset(ctx, convID, []byte(`{"reason":"orchestrator_reset"}`)); rErr != nil {
			return ConversationState{}, rErr
		}
		if err := o.appendSystemAndDoc(ctx, convID, agentID, opts.ChannelID, sysPrompt); err != nil {
			return ConversationState{}, err
		}
	}

	return o.Status(ctx, convID)
}

func (o *Orchestrator) appendSystemAndDoc(ctx context.Context, convID, agentID, channelID, sysPrompt string) error {
	sysBytes, err := json.Marshal(map[string]any{"text": sysPrompt})
	if err != nil {
		return err
	}
	if _, err := o.stack.Store.AppendEntry(ctx, convID, store.EntrySystem, sysBytes); err != nil {
		return err
	}
	agentDoc, err := json.Marshal(map[string]any{
		"role":      "orchestrator",
		"agentId":   agentID,
		"channelId": channelID,
	})
	if err != nil {
		return err
	}
	_, err = o.stack.Store.PutDocument(ctx, store.ScopeConversation, convID, store.DocAgent, agentDoc)
	return err
}

// Send appends user input to the durable ledger and schedules an asynchronous (or synchronous when Wait=true) turn.
func (o *Orchestrator) Send(ctx context.Context, req SendRequest) (SendResult, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if err := ctx.Err(); err != nil {
		return SendResult{}, err
	}
	if o.stack.closed.Load() {
		return SendResult{}, ErrClosed
	}
	if strings.TrimSpace(req.Text) == "" {
		return SendResult{}, fmt.Errorf("%w: text is required", ErrInvalidConfig)
	}

	agentID := firstNonEmpty(req.AgentID, o.cfg.AgentID)
	convID := firstNonEmpty(req.ConversationID, "orch-"+agentID)

	if _, err := o.Open(ctx, OpenOptions{
		ConversationID: convID,
		AgentID:        agentID,
		ChannelID:      req.ChannelID,
	}); err != nil {
		return SendResult{}, err
	}

	var subID string
	var taskID string
	if reqID := strings.TrimSpace(req.RequestID); reqID != "" {
		subPayload, _ := json.Marshal(map[string]any{
			"text":      req.Text,
			"channelId": req.ChannelID,
			"source":    firstNonEmpty(req.Source, "user"),
		})
		subRes, sErr := o.stack.Store.Submit(ctx, store.Submission{
			ConversationID: convID,
			RequestID:      reqID,
			Kind:           "orchestrator_turn",
			PayloadJSON:    subPayload,
		})
		if sErr != nil {
			return SendResult{}, sErr
		}
		subID = subRes.Submission.ID
		taskID = "orch-turn-" + subID
		if subRes.Deduplicated {
			existingTask, gErr := o.stack.Store.GetTask(ctx, taskID)
			if gErr == nil {
				return o.finishOrReturnSend(ctx, convID, subID, existingTask, req)
			}
		}
	} else {
		taskID = "orch-turn-" + newShortHexID()
	}

	// Reject concurrent active turns on the same orchestrator conversation.
	tasks, err := o.stack.Store.ListTasksByConversation(ctx, convID)
	if err != nil {
		return SendResult{}, err
	}
	for _, tk := range tasks {
		if tk.Kind == durable.TaskKindGeneration && tk.Status != store.TaskTerminal {
			return SendResult{}, ErrOrchestratorBusy
		}
	}

	source := firstNonEmpty(req.Source, "user")
	userPayloadMap := map[string]any{
		"text":   req.Text,
		"source": source,
	}
	if req.ChannelID != "" {
		userPayloadMap["channelId"] = req.ChannelID
	}
	if req.UserID != "" {
		userPayloadMap["userId"] = req.UserID
	}
	if req.IncludeContext {
		if sit := BuildSituationSummary(ctx, o.stack, req.ChannelID); sit != "" {
			userPayloadMap["situation"] = sit
		}
	}
	userBytes, err := json.Marshal(userPayloadMap)
	if err != nil {
		return SendResult{}, err
	}
	if _, err := o.stack.Store.AppendEntry(ctx, convID, store.EntryUser, userBytes); err != nil {
		return SendResult{}, err
	}

	cpBytes, err := json.Marshal(durable.GenerationCheckpoint{
		ConversationID: convID,
		TaskPrompt:     req.Text,
		Tools:          o.tools.Specs(),
	})
	if err != nil {
		return SendResult{}, err
	}

	var deltaMu sync.Mutex
	var emitted string
	emitChunk := func(chunk string) {
		if chunk == "" || req.OnDelta == nil {
			return
		}
		deltaMu.Lock()
		emitted += chunk
		deltaMu.Unlock()
		req.OnDelta(chunk)
	}
	emitFinalOutput := func(full string) {
		if full == "" || req.OnDelta == nil {
			return
		}
		deltaMu.Lock()
		var rem string
		if strings.HasPrefix(full, emitted) {
			rem = full[len(emitted):]
		} else if emitted == "" {
			rem = full
		}
		emitted += rem
		deltaMu.Unlock()
		if rem != "" {
			req.OnDelta(rem)
		}
	}

	if req.OnDelta != nil {
		unhook := o.registerStreamHook(convID, func(chunk string) {
			emitChunk(chunk)
		})
		defer unhook()
	}

	created, err := o.stack.Scheduler.StartTask(ctx, store.Task{
		ID:             taskID,
		ConversationID: convID,
		Kind:           durable.TaskKindGeneration,
		PhaseName:      durable.PhaseGenerate,
		IsModelTask:    true,
		CheckpointJSON: cpBytes,
	})
	if err != nil {
		return SendResult{}, err
	}

	res, err := o.finishOrReturnSend(ctx, convID, subID, created.Task, req)
	if err == nil && res.Output != "" {
		emitFinalOutput(res.Output)
	}
	return res, err
}

func (o *Orchestrator) finishOrReturnSend(ctx context.Context, convID, subID string, task store.Task, req SendRequest) (SendResult, error) {
	if !req.Wait && req.OnDelta == nil {
		return SendResult{
			ConversationID: convID,
			TaskID:         task.ID,
			SubmissionID:   subID,
			Status:         string(task.Status),
			Task:           task,
		}, nil
	}

	finalTask, err := o.stack.Scheduler.WaitTask(ctx, task.ID)
	if err != nil {
		if ctx.Err() != nil {
			_ = o.stack.Scheduler.AbortTask(context.Background(), task.ID, store.ReasonAborted)
		}
		return SendResult{}, err
	}

	res := SendResult{
		ConversationID: convID,
		TaskID:         finalTask.ID,
		SubmissionID:   subID,
		Status:         string(finalTask.Status),
		ErrorText:      finalTask.ErrorText,
		Task:           finalTask,
	}
	if finalTask.TerminalReason == store.ReasonCompleted {
		var genRes durable.GenerationResult
		if json.Unmarshal(finalTask.ResultJSON, &genRes) == nil {
			res.Output = genRes.Output
		}
		if subID != "" {
			_, _ = o.stack.Store.SettleSubmission(ctx, subID, store.SubmissionDone, finalTask.ResultJSON)
		}
		return res, nil
	}

	errText := finalTask.ErrorText
	if errText == "" {
		errText = finalTask.TerminalReason
	}
	if errText == "" {
		errText = string(finalTask.Status)
	}
	res.ErrorText = errText
	if subID != "" {
		errPayload, _ := json.Marshal(map[string]any{"error": errText})
		_, _ = o.stack.Store.SettleSubmission(ctx, subID, store.SubmissionUnanswered, errPayload)
	}
	return res, fmt.Errorf("orchestrator turn %s: %s", finalTask.ID, errText)
}

// Stop aborts any active generation tasks on conversationID without stopping unrelated worker sessions.
func (o *Orchestrator) Stop(ctx context.Context, conversationID string) error {
	if ctx == nil {
		ctx = context.Background()
	}
	if o.stack.closed.Load() {
		return ErrClosed
	}
	convID := firstNonEmpty(conversationID, o.DefaultConversationID())
	tasks, err := o.stack.Store.ListTasksByConversation(ctx, convID)
	if err != nil {
		return err
	}
	var firstErr error
	for _, tk := range tasks {
		if tk.Status == store.TaskTerminal {
			continue
		}
		if aErr := o.stack.Scheduler.AbortTask(ctx, tk.ID, store.ReasonAborted); aErr != nil && firstErr == nil {
			firstErr = aErr
		}
	}
	return firstErr
}

// Answer runs a synchronous turn on conversationID and streams assistant deltas to onDelta.
func (o *Orchestrator) Answer(ctx context.Context, conversationID, text string, onDelta func(chunk string)) (SendResult, error) {
	return o.Send(ctx, SendRequest{
		ConversationID: conversationID,
		Text:           text,
		Wait:           true,
		OnDelta:        onDelta,
	})
}

// Status returns the current durable conversation status, active task, budget snapshot, and last output.
func (o *Orchestrator) Status(ctx context.Context, conversationID string) (ConversationState, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	if o.stack.closed.Load() {
		return ConversationState{}, ErrClosed
	}
	convID := firstNonEmpty(conversationID, o.DefaultConversationID())
	state := ConversationState{
		ConversationID: convID,
		AgentID:        o.cfg.AgentID,
	}

	conv, err := o.stack.Store.GetConversation(ctx, convID)
	if errors.Is(err, store.ErrNotFound) {
		return state, nil
	}
	if err != nil {
		return ConversationState{}, err
	}
	state.Exists = true
	state.ProviderAffinity = conv.ProviderAffinity
	state.HeadSeq = conv.HeadSeq

	entries, err := o.stack.Store.GetVisibleEntries(ctx, convID)
	if err == nil {
		state.EntryCount = len(entries)
		for i := len(entries) - 1; i >= 0; i-- {
			if entries[i].Kind == store.EntryAssistant {
				state.LastOutput = extractEntryText(entries[i].PayloadJSON)
				break
			}
		}
	}

	tasks, err := o.stack.Store.ListTasksByConversation(ctx, convID)
	if err == nil {
		state.Tasks = tasks
		for i := len(tasks) - 1; i >= 0; i-- {
			tk := tasks[i]
			if tk.Status != store.TaskTerminal {
				state.Active = true
				state.ActiveTaskID = tk.ID
				state.ActiveStatus = tk.Status
				break
			}
			if state.LastOutput == "" && tk.TerminalReason == store.ReasonCompleted {
				var genRes durable.GenerationResult
				if json.Unmarshal(tk.ResultJSON, &genRes) == nil && genRes.Output != "" {
					state.LastOutput = genRes.Output
				}
			}
		}
	}

	if o.stack.Budget != nil {
		if snap, bErr := o.stack.Budget.Snapshot(ctx, convID); bErr == nil {
			state.Budget = &snap
		}
	}
	return state, nil
}

// ChatCompletionsOpenAI implements an OpenAI-compatible POST /v1/chat/completions HTTP & SSE handler.
func (o *Orchestrator) ChatCompletionsOpenAI(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeOpenAIError(w, http.StatusMethodNotAllowed, "invalid_request_error", "method_not_allowed", "only POST is supported")
		return
	}
	if o.stack.closed.Load() {
		writeOpenAIError(w, http.StatusServiceUnavailable, "server_error", "server_closed", "orchestrator is closed")
		return
	}

	limit := o.cfg.MaxBodyBytes
	if limit <= 0 {
		limit = defaultOpenAIBodyMaxBytes
	}
	if r.ContentLength > limit {
		writeOpenAIError(w, http.StatusRequestEntityTooLarge, "invalid_request_error", "request_too_large", fmt.Sprintf("body exceeds %d bytes", limit))
		return
	}

	rawBody, err := io.ReadAll(io.LimitReader(r.Body, limit+1))
	if err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "read_failed", err.Error())
		return
	}
	if int64(len(rawBody)) > limit {
		writeOpenAIError(w, http.StatusRequestEntityTooLarge, "invalid_request_error", "request_too_large", fmt.Sprintf("body exceeds %d bytes", limit))
		return
	}

	var req struct {
		Model          string `json:"model"`
		Stream         bool   `json:"stream"`
		ConversationID string `json:"conversation_id"`
		Messages       []struct {
			Role    string `json:"role"`
			Content any    `json:"content"`
		} `json:"messages"`
	}
	if err := json.Unmarshal(rawBody, &req); err != nil {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "invalid_json", err.Error())
		return
	}

	modelName := strings.TrimSpace(req.Model)
	if !o.isSupportedChatModel(modelName) {
		writeOpenAIError(w, http.StatusNotFound, "invalid_request_error", "model_not_found", "no model "+modelName)
		return
	}
	if modelName == "" {
		modelName = "vibevalley-orchestrator"
	}

	var userText string
	for i := len(req.Messages) - 1; i >= 0; i-- {
		if req.Messages[i].Role == "user" {
			userText = extractOpenAIMessageText(req.Messages[i].Content)
			if userText != "" {
				break
			}
		}
	}
	if userText == "" {
		writeOpenAIError(w, http.StatusBadRequest, "invalid_request_error", "no_user_message", "no user message to answer")
		return
	}

	convID := strings.TrimSpace(req.ConversationID)
	if convID == "" {
		convID = o.DefaultConversationID()
	}

	cmplID := "chatcmpl-" + newShortHexID()
	created := o.stack.clock.NowMs() / 1000

	if !req.Stream {
		res, err := o.Answer(r.Context(), convID, userText, nil)
		if err != nil {
			if errors.Is(err, ErrOrchestratorBusy) {
				writeOpenAIError(w, http.StatusConflict, "invalid_request_error", "conversation_busy", err.Error())
				return
			}
			writeOpenAIError(w, http.StatusBadGateway, "server_error", "not_answered", err.Error())
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"id":      cmplID,
			"object":  "chat.completion",
			"created": created,
			"model":   modelName,
			"choices": []map[string]any{
				{
					"index": 0,
					"message": map[string]any{
						"role":    "assistant",
						"content": res.Output,
					},
					"finish_reason": "stop",
				},
			},
		})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.WriteHeader(http.StatusOK)

	flusher, canFlush := w.(http.Flusher)
	if canFlush {
		flusher.Flush()
	}

	var writeMu sync.Mutex
	sentFirst := false
	writeChunk := func(content string, stop bool) {
		writeMu.Lock()
		defer writeMu.Unlock()
		var delta map[string]any
		var finish any
		if stop {
			delta = map[string]any{}
			finish = "stop"
		} else {
			delta = map[string]any{"content": content}
			if !sentFirst {
				delta["role"] = "assistant"
				sentFirst = true
			}
			finish = nil
		}
		payload, _ := json.Marshal(map[string]any{
			"id":      cmplID,
			"object":  "chat.completion.chunk",
			"created": created,
			"model":   modelName,
			"choices": []map[string]any{
				{
					"index":         0,
					"delta":         delta,
					"finish_reason": finish,
				},
			},
		})
		_, _ = fmt.Fprintf(w, "data: %s\n\n", payload)
		if canFlush {
			flusher.Flush()
		}
	}

	_, err = o.Answer(r.Context(), convID, userText, func(chunk string) {
		if chunk != "" {
			writeChunk(chunk, false)
		}
	})
	if err != nil {
		// Mirror TypeScript openai.ts: stream ends without [DONE] if answer fails or aborts midway.
		return
	}

	writeChunk("", true)
	writeMu.Lock()
	_, _ = fmt.Fprint(w, "data: [DONE]\n\n")
	if canFlush {
		flusher.Flush()
	}
	writeMu.Unlock()
}

func (o *Orchestrator) isSupportedChatModel(model string) bool {
	if model == "" || model == "vibevalley-orchestrator" || model == "default" || model == o.cfg.DefaultModel {
		return true
	}
	prov, _ := provider.ResolveProvider("", model)
	return prov != ""
}

func extractOpenAIMessageText(raw any) string {
	switch v := raw.(type) {
	case string:
		return strings.TrimSpace(v)
	case []any:
		var b strings.Builder
		for _, item := range v {
			part, ok := item.(map[string]any)
			if !ok {
				continue
			}
			if typ, _ := part["type"].(string); typ == "text" {
				if txt, _ := part["text"].(string); txt != "" {
					b.WriteString(txt)
				}
			}
		}
		return strings.TrimSpace(b.String())
	default:
		return ""
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeOpenAIError(w http.ResponseWriter, status int, kind, code, msg string) {
	writeJSON(w, status, map[string]any{
		"error": map[string]any{
			"message": msg,
			"type":    kind,
			"code":    code,
		},
	})
}

func (o *Orchestrator) registerStreamHook(convID string, fn func(string)) func() {
	o.streamMu.Lock()
	o.streamHooks[convID] = fn
	o.streamMu.Unlock()
	return func() {
		o.streamMu.Lock()
		delete(o.streamHooks, convID)
		o.streamMu.Unlock()
	}
}

func (o *Orchestrator) emitStreamHook(convID, chunk string) {
	if chunk == "" {
		return
	}
	o.streamMu.RLock()
	fn := o.streamHooks[convID]
	o.streamMu.RUnlock()
	if fn != nil {
		fn(chunk)
	}
}

type orchestratorStreamModel struct {
	orch *Orchestrator
	base durable.ModelClient
}

func (m *orchestratorStreamModel) Generate(ctx context.Context, req durable.ModelRequest, onDelta func(chunk string)) (durable.ModelResponse, error) {
	streamedAny := false
	wrappedDelta := func(chunk string) {
		if chunk != "" {
			streamedAny = true
		}
		if onDelta != nil {
			onDelta(chunk)
		}
		m.orch.emitStreamHook(req.ConversationID, chunk)
	}
	resp, err := m.base.Generate(ctx, req, wrappedDelta)
	if err != nil {
		return resp, err
	}
	// If underlying ModelClient returned non-empty Text without streaming deltas (e.g. a test mock),
	// forward the completed text to any active stream hook once.
	if !streamedAny && len(resp.Streamed) == 0 && resp.Text != "" && len(resp.ToolCalls) == 0 {
		m.orch.emitStreamHook(req.ConversationID, resp.Text)
	}
	return resp, nil
}

func newShortHexID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return hex.EncodeToString(b[:])
}
