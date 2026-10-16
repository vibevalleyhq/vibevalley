package agentcore

// The agent: the loop with state, as pi-agent-core's Agent. It holds the transcript, the model and the tools; one
// run at a time (Prompt while one runs is refused: Steer or FollowUp instead); the state follows the run's events
// before they are published, so whoever hears an event sees the state that goes with it. Abort cancels the run,
// which ends it with an aborted answer (loop.go). Runs live as long as the agent: Close (or the context it was made
// with ending) stops them.

import (
	"context"
	"sync"

	"vibevalley/pkg/ai"
)

// AgentError is why the agent did not do what it was asked: Reason "busy", "empty" or "nothing-to-continue".
type AgentError struct {
	Reason  string
	Message string
}

func (e *AgentError) Error() string { return e.Message }

type AgentInitialState struct {
	SystemPrompt  string
	Model         ai.Model
	ThinkingLevel ThinkingLevel
	Tools         []AgentTool
	Messages      []AgentMessage
}

// AgentOptions is the agent's start and its hooks. The loop config's Model and ThinkingLevel come from the state,
// its steering and follow-up getters from the agent's queues: those set here are not used.
type AgentOptions struct {
	AgentLoopConfig
	InitialState AgentInitialState
	SteeringMode QueueMode
	FollowUpMode QueueMode
}

type runHandle struct {
	cancel context.CancelFunc
	done   chan struct{}
}

// Agent is the stateful agent. Safe for concurrent use.
type Agent struct {
	options AgentOptions
	ctx     context.Context
	close   context.CancelFunc

	// emitMu keeps a state change and its event together, in order.
	emitMu sync.Mutex
	mu     sync.Mutex
	state  AgentState
	events *Hub[AgentEvent]
	states *Hub[AgentState]

	steeringQueue []AgentMessage
	followUpQueue []AgentMessage
	steeringMode  QueueMode
	followUpMode  QueueMode
	// The run under way; nil when idle.
	current *runHandle
}

// ApplyEvent is the state after an event: the transcript grows at message_end, the answer being said is shown until then.
func ApplyEvent(state AgentState, event AgentEvent) AgentState {
	switch event.Type {
	case EventAgentStart:
		state.ErrorMessage = ""
		state.IsStreaming = true
	case EventAgentEnd:
		state.StreamingMessage = nil
		state.IsStreaming = false
		state.PendingToolCalls = map[string]bool{}
	case EventMessageStart, EventMessageUpdate:
		if event.Message.Role() == "assistant" {
			state.StreamingMessage = event.Message
		}
	case EventMessageEnd:
		state.StreamingMessage = nil
		state.Messages = append(append([]AgentMessage(nil), state.Messages...), event.Message)
		if m, ok := event.Message.(ai.AssistantMessage); ok && (m.StopReason == ai.StopError || m.StopReason == ai.StopAborted) && m.ErrorMessage != "" {
			state.ErrorMessage = m.ErrorMessage
		}
	case EventToolExecutionStart:
		pending := make(map[string]bool, len(state.PendingToolCalls)+1)
		for k := range state.PendingToolCalls {
			pending[k] = true
		}
		pending[event.ToolCallID] = true
		state.PendingToolCalls = pending
	case EventToolExecutionEnd:
		pending := make(map[string]bool, len(state.PendingToolCalls))
		for k := range state.PendingToolCalls {
			if k != event.ToolCallID {
				pending[k] = true
			}
		}
		state.PendingToolCalls = pending
	case EventTurnStart, EventTurnEnd, EventToolExecutionUpdate:
	}
	return state
}

// NewAgent makes an agent; it lives until Close or until ctx ends. ctx's values (ai.WithProviders) reach every request.
func NewAgent(ctx context.Context, options AgentOptions) *Agent {
	life, cancel := context.WithCancel(ctx)
	level := options.InitialState.ThinkingLevel
	if level == "" {
		level = "off"
	}
	a := &Agent{
		options: options,
		ctx:     life,
		close:   cancel,
		state: AgentState{
			SystemPrompt:     options.InitialState.SystemPrompt,
			Model:            options.InitialState.Model,
			ThinkingLevel:    level,
			Tools:            append([]AgentTool(nil), options.InitialState.Tools...),
			Messages:         append([]AgentMessage(nil), options.InitialState.Messages...),
			PendingToolCalls: map[string]bool{},
		},
		events:       NewHub[AgentEvent](),
		states:       NewHub[AgentState](),
		steeringMode: options.SteeringMode,
		followUpMode: options.FollowUpMode,
	}
	if a.steeringMode == "" {
		a.steeringMode = OneAtATime
	}
	if a.followUpMode == "" {
		a.followUpMode = OneAtATime
	}
	go func() {
		<-life.Done()
		a.Abort()
		a.events.Close()
		a.states.Close()
	}()
	return a
}

// Close stops the run under way and ends the subscriptions.
func (a *Agent) Close() {
	a.close()
	a.Abort()
	a.events.Close()
	a.states.Close()
}

// State is the state now (a copy).
func (a *Agent) State() AgentState {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.state.clone()
}

// Subscribe is the events from now on; Close the subscription when done.
func (a *Agent) Subscribe() *Subscription[AgentEvent] { return a.events.Subscribe() }

// SubscribeState is the state each time it changes.
func (a *Agent) SubscribeState() *Subscription[AgentState] { return a.states.Subscribe() }

func (a *Agent) emit(event AgentEvent) {
	a.emitMu.Lock()
	defer a.emitMu.Unlock()
	a.mu.Lock()
	a.state = ApplyEvent(a.state, event)
	snapshot := a.state.clone()
	a.mu.Unlock()
	a.events.Publish(event)
	a.states.Publish(snapshot)
}

func (a *Agent) set(f func(s *AgentState)) {
	a.emitMu.Lock()
	defer a.emitMu.Unlock()
	a.mu.Lock()
	f(&a.state)
	snapshot := a.state.clone()
	a.mu.Unlock()
	a.states.Publish(snapshot)
}

func take(queue *[]AgentMessage, mode QueueMode) []AgentMessage {
	if len(*queue) == 0 {
		return nil
	}
	if mode == QueueAll {
		out := *queue
		*queue = nil
		return out
	}
	out := []AgentMessage{(*queue)[0]}
	*queue = (*queue)[1:]
	return out
}

func (a *Agent) config(s AgentState) AgentLoopConfig {
	loop := a.options.AgentLoopConfig
	loop.Model = s.Model
	loop.ThinkingLevel = s.ThinkingLevel
	loop.GetSteeringMessages = func() []AgentMessage {
		a.mu.Lock()
		defer a.mu.Unlock()
		return take(&a.steeringQueue, a.steeringMode)
	}
	loop.GetFollowUpMessages = func() []AgentMessage {
		a.mu.Lock()
		defer a.mu.Unlock()
		return take(&a.followUpQueue, a.followUpMode)
	}
	return loop
}

func contextOf(s AgentState) AgentContext {
	return AgentContext{SystemPrompt: s.SystemPrompt, Messages: s.Messages, Tools: s.Tools}
}

// startLocked starts body as the run (a.mu held, nothing under way).
func (a *Agent) startLocked(body func(ctx context.Context, s AgentState)) *runHandle {
	runCtx, cancel := context.WithCancel(a.ctx)
	h := &runHandle{cancel: cancel, done: make(chan struct{})}
	a.current = h
	s := a.state.clone()
	go func() {
		defer func() {
			cancel()
			a.mu.Lock()
			if a.current == h {
				a.current = nil
			}
			a.mu.Unlock()
			close(h.done)
		}()
		body(runCtx, s)
	}()
	return h
}

func wait(ctx context.Context, h *runHandle) error {
	select {
	case <-h.done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

var errBusy = &AgentError{Reason: "busy", Message: "正在跑：用 steer 或 followUp"}

// Prompt starts a run with messages and waits for it to end (or for ctx; the run goes on). Refused while one runs.
func (a *Agent) Prompt(ctx context.Context, messages ...AgentMessage) error {
	a.mu.Lock()
	if a.current != nil {
		a.mu.Unlock()
		return errBusy
	}
	h := a.startLocked(func(runCtx context.Context, s AgentState) {
		RunAgentLoop(runCtx, messages, contextOf(s), a.config(s), a.emit)
	})
	a.mu.Unlock()
	return wait(ctx, h)
}

// PromptText is Prompt with a user's words, and images.
func (a *Agent) PromptText(ctx context.Context, text string, images ...ai.Content) error {
	return a.Prompt(ctx, UserMessageOf(text, images...))
}

// UserMessageOf is a user's words (and images) as a message.
func UserMessageOf(text string, images ...ai.Content) ai.UserMessage {
	content := ai.StringContent(text)
	if len(images) > 0 {
		content = ai.BlocksContent(append([]ai.Content{ai.NewText(text)}, images...)...)
	}
	return ai.UserMessage{Content: content, Timestamp: now()}
}

// Continue goes on from the transcript: from its tail, or, when the tail is the model's, with what is queued.
func (a *Agent) Continue(ctx context.Context) error {
	a.mu.Lock()
	if a.current != nil {
		a.mu.Unlock()
		return &AgentError{Reason: "busy", Message: "正在跑"}
	}
	meaningful := 0
	for _, m := range a.state.Messages {
		if m.Role() != "system" {
			meaningful++
		}
	}
	if meaningful == 0 {
		a.mu.Unlock()
		return &AgentError{Reason: "empty", Message: "还没有对话，没法接着"}
	}
	if last := a.state.Messages[len(a.state.Messages)-1]; last.Role() != "assistant" {
		h := a.startLocked(func(runCtx context.Context, s AgentState) {
			RunAgentLoopContinue(runCtx, contextOf(s), a.config(s), a.emit)
		})
		a.mu.Unlock()
		return wait(ctx, h)
	}
	// The model spoke last: go on with what is queued, steering first.
	var queued []AgentMessage
	if len(a.steeringQueue) > 0 {
		queued = take(&a.steeringQueue, a.steeringMode)
	} else {
		queued = take(&a.followUpQueue, a.followUpMode)
	}
	if len(queued) == 0 {
		a.mu.Unlock()
		return &AgentError{Reason: "nothing-to-continue", Message: "最后一句是模型的，也没有排着的话"}
	}
	h := a.startLocked(func(runCtx context.Context, s AgentState) {
		RunAgentLoop(runCtx, queued, contextOf(s), a.config(s), a.emit)
	})
	a.mu.Unlock()
	return wait(ctx, h)
}

// Steer puts a message in before the next request of the run under way.
func (a *Agent) Steer(m AgentMessage) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.steeringQueue = append(a.steeringQueue, m)
}

// FollowUp is a message taken when the run would stop.
func (a *Agent) FollowUp(m AgentMessage) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.followUpQueue = append(a.followUpQueue, m)
}

func (a *Agent) ClearSteeringQueue() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.steeringQueue = nil
}

func (a *Agent) ClearFollowUpQueue() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.followUpQueue = nil
}

func (a *Agent) ClearAllQueues() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.steeringQueue = nil
	a.followUpQueue = nil
}

func (a *Agent) HasQueuedMessages() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.steeringQueue)+len(a.followUpQueue) > 0
}

func (a *Agent) PeekQueuedMessages() []AgentMessage {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append(append([]AgentMessage{}, a.steeringQueue...), a.followUpQueue...)
}

// Abort stops the run under way; it ends with an aborted answer. It returns once it has.
func (a *Agent) Abort() {
	a.mu.Lock()
	h := a.current
	a.mu.Unlock()
	if h != nil {
		h.cancel()
		<-h.done
	}
}

// IsRunning reports a run under way.
func (a *Agent) IsRunning() bool {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.current != nil
}

// WaitForIdle returns when no run is under way (or ctx ends).
func (a *Agent) WaitForIdle(ctx context.Context) error {
	for {
		a.mu.Lock()
		h := a.current
		a.mu.Unlock()
		if h == nil {
			return nil
		}
		if err := wait(ctx, h); err != nil {
			return err
		}
	}
}

// Reset stops, then forgets the transcript and what was queued.
func (a *Agent) Reset() {
	a.Abort()
	a.ClearAllQueues()
	a.set(func(s *AgentState) {
		s.Messages = nil
		s.IsStreaming = false
		s.PendingToolCalls = map[string]bool{}
	})
}

func (a *Agent) SetSystemPrompt(systemPrompt string) {
	a.set(func(s *AgentState) { s.SystemPrompt = systemPrompt })
}
func (a *Agent) SetModel(model ai.Model) { a.set(func(s *AgentState) { s.Model = model }) }
func (a *Agent) SetThinkingLevel(level ThinkingLevel) {
	a.set(func(s *AgentState) { s.ThinkingLevel = level })
}
func (a *Agent) SetTools(tools []AgentTool) {
	a.set(func(s *AgentState) { s.Tools = append([]AgentTool(nil), tools...) })
}
func (a *Agent) SetMessages(messages []AgentMessage) {
	a.set(func(s *AgentState) { s.Messages = append([]AgentMessage(nil), messages...) })
}
func (a *Agent) SetSteeringMode(mode QueueMode) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.steeringMode = mode
}
func (a *Agent) SetFollowUpMode(mode QueueMode) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.followUpMode = mode
}
