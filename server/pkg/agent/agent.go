package agent

// A message is saved before its message_end is passed on. Past its budget the older part of the conversation is folded into a summary: for a request
// as soon as it is too long, in the file once the run is over.

import (
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

const (
	EventAgentSettled    = "agent_settled"
	EventCompactionStart = "compaction_start"
	EventCompactionEnd   = "compaction_end"
)

// AgentEvent is an agentcore event, or one of this agent's own: agent_settled (Aborted), compaction_start
// (Reason "threshold"), compaction_end (Reason, Compaction: nil when nothing was folded).
type AgentEvent struct {
	agentcore.AgentEvent
	Aborted bool
	Reason  string
	// Not Result: agentcore.AgentEvent has a Result of its own.
	Compaction *CompactionSummaryMessage
}

type AgentOptions struct {
	// Also the session file's name unless Session says otherwise.
	Name          string
	Instructions  string
	Model         ai.Model
	StreamOptions ai.StreamOptions
	// The key, asked before each request (and each summary), so a key changed meanwhile is used at once.
	GetApiKey     func(ctx context.Context, provider string) string
	ThinkingLevel agentcore.ThinkingLevel
	Home          string
	Cwd           string
	Tools         []agentcore.AgentTool
	// nil: the shared, Claude Code's and the work directory's. NoSkills for none.
	Skills   []string
	NoSkills bool
	NoMemory bool
	// 40 when 0.
	MaxSteps int
	// Tokens (estimated) past which the older part is folded; 120 000 when 0.
	ContextTokens int
	// 12 when 0.
	KeepRecent int
	// "": Name. NoSession keeps nothing on disk (a helper).
	Session   string
	NoSession bool
	// Not kept.
	Situation func(ctx context.Context) string
	// A helper never can.
	NoSubagents bool
	// nil: when it keeps a session.
	Schedules *bool
	// 20 s when 0.
	ScheduleTick time.Duration
	// Default Later.
	Wake func(text string)
}

// Safe for concurrent use; Close (or the context it was made with ending) stops it.
type Agent struct {
	Core *agentcore.Agent

	options AgentOptions
	ctx     context.Context
	cancel  context.CancelFunc
	session Session
	skills  func() []SkillInfo
	folding CompactionOptions
	events  *agentcore.Hub[AgentEvent]
	done    sync.WaitGroup

	mu       sync.Mutex
	runs     int
	waiters  []chan struct{}
	steps    int
	stopping bool
	// Made once per place.
	folds  map[string]CompactionSummaryMessage
	foldMu sync.Mutex
}

// ctx's values (ai.WithProviders) reach every request, and its end stops the agent.
func NewAgent(ctx context.Context, options AgentOptions) *Agent {
	life, cancel := context.WithCancel(ctx)
	a := &Agent{options: options, ctx: life, cancel: cancel, events: agentcore.NewHub[AgentEvent](), folds: map[string]CompactionSummaryMessage{}}
	maxSteps := options.MaxSteps
	if maxSteps == 0 {
		maxSteps = 40
	}
	sessionName := options.Session
	if sessionName == "" {
		sessionName = options.Name
	}
	if !options.NoSession {
		a.session = SessionAt(filepath.Join(options.Home, sessionName+".jsonl"))
	}
	var skillDirs []string
	if !options.NoSkills {
		skillDirs = options.Skills
		if skillDirs == nil {
			skillDirs = DefaultSkillDirs(options.Cwd)
		}
	}
	a.skills = func() []SkillInfo { return ScanSkills(skillDirs) }
	budget := options.ContextTokens
	if budget == 0 {
		budget = 120_000
	}
	keepRecent := options.KeepRecent
	if keepRecent == 0 {
		keepRecent = 12
	}
	a.folding = CompactionOptions{Home: options.Home, Session: sessionName, Model: options.Model, StreamOptions: options.StreamOptions, Budget: budget, KeepRecent: keepRecent}

	own := SelfTools(SelfOptions{Home: options.Home, Skills: a.skills, Memory: !options.NoMemory})
	if !options.NoSubagents {
		own = append(own, SubagentTool(func(ctx context.Context, task, label string) (string, error) {
			helper := NewAgent(ctx, AgentOptions{
				Name:          options.Name + "-帮手",
				Instructions:  SUBAGENT_INSTRUCTIONS(options.Name),
				Model:         options.Model,
				StreamOptions: options.StreamOptions,
				GetApiKey:     options.GetApiKey,
				ThinkingLevel: options.ThinkingLevel,
				Home:          options.Home,
				Cwd:           options.Cwd,
				Tools:         options.Tools,
				Skills:        skillDirs,
				NoSkills:      options.NoSkills,
				NoMemory:      true,
				MaxSteps:      30,
				NoSession:     true,
				NoSubagents:   true,
				Schedules:     new(false),
			})
			defer helper.Close()
			said, err := helper.Ask(ctx, UserMessage(task))
			if err != nil {
				return "", err
			}
			if said == "" {
				said = "帮手「" + label + "」没有交回结果。"
			}
			return said, nil
		}))
	}

	var messages []agentcore.AgentMessage
	if a.session != nil {
		messages = a.session.Load()
	}
	tools := append(append([]agentcore.AgentTool{}, options.Tools...), own...)
	a.Core = agentcore.NewAgent(life, agentcore.AgentOptions{
		InitialState: agentcore.AgentInitialState{Model: options.Model, ThinkingLevel: options.ThinkingLevel, Tools: tools, Messages: messages},
		AgentLoopConfig: agentcore.AgentLoopConfig{
			StreamOptions: options.StreamOptions,
			GetApiKey:     options.GetApiKey,
			ConvertToLlm:  ConvertToLlm,
			TransformContext: func(ctx context.Context, messages []agentcore.AgentMessage) []agentcore.AgentMessage {
				if summary, cut, ok := a.fold(ctx, messages); ok {
					return append([]agentcore.AgentMessage{summary}, messages[cut:]...)
				}
				return messages
			},
			PrepareRequest: func(ctx context.Context, p agentcore.PrepareRequestContext) *agentcore.AgentRequestUpdate {
				c := p.Context
				c.SystemPrompt = a.systemPrompt(ctx)
				return &agentcore.AgentRequestUpdate{Context: &c}
			},
			FinishTurn: func(context.Context, agentcore.AgentTurnContext) *agentcore.AgentTurnDecision {
				a.mu.Lock()
				defer a.mu.Unlock()
				a.steps++
				if a.steps >= maxSteps {
					return agentcore.TurnEnd
				}
				return nil
			},
		},
	})

	// The core's events, in order: each message saved before it is passed on; after a run's end, what follows it.
	core := a.Core.Subscribe()
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		defer core.Close()
		for {
			select {
			case e, ok := <-core.C:
				if !ok {
					return
				}
				if e.Type == agentcore.EventMessageEnd && a.session != nil {
					_ = a.session.Append(e.Message)
				}
				a.publish(AgentEvent{AgentEvent: e})
				if e.Type == agentcore.EventAgentEnd {
					a.ended()
				}
			case <-life.Done():
				return
			}
		}
	}()

	schedules := a.session != nil
	if options.Schedules != nil {
		schedules = *options.Schedules
	}
	if schedules {
		wake := options.Wake
		if wake == nil {
			wake = func(text string) { a.Later(NewCustomMessage("schedule", ai.StringContent(text))) }
		}
		s := MakeSchedules(options.Home, wake)
		a.Core.SetTools(append(a.Core.State().Tools, s.Tools...))
		tick := options.ScheduleTick
		if tick == 0 {
			tick = 20 * time.Second
		}
		a.done.Add(1)
		go func() {
			defer a.done.Done()
			// The first look is at once: what came due while it was away runs now, once.
			s.Tick(time.Now())
			ticker := time.NewTicker(tick)
			defer ticker.Stop()
			for {
				select {
				case <-ticker.C:
					s.Tick(time.Now())
				case <-life.Done():
					return
				}
			}
		}()
	}
	return a
}

func (a *Agent) publish(e AgentEvent) { a.events.Publish(e) }

func (a *Agent) systemPrompt(ctx context.Context) string {
	found := a.skills()
	memory := ""
	if !a.options.NoMemory {
		memory = ReadMemory(a.options.Home)
	}
	situation := ""
	if a.options.Situation != nil {
		situation = a.options.Situation(ctx)
	}
	parts := []string{
		strings.TrimSpace(a.options.Instructions),
		"## 环境\n- 工作目录：" + a.options.Cwd + "\n- 现在：" + localeTime(time.Now()),
	}
	if len(found) > 0 {
		parts = append(parts, "## 技能\n要用哪个先用 load_skill 读它的全文，再照着做：\n"+SkillIndex(found, 0))
	}
	if memory != "" {
		parts = append(parts, "## 记性（你以前记下的）\n"+memory)
	}
	parts = append(parts, situation)
	var kept []string
	for _, p := range parts {
		if p != "" {
			kept = append(kept, p)
		}
	}
	return strings.Join(kept, "\n\n")
}

func foldKey(messages []agentcore.AgentMessage, cut int) string {
	var at int64
	if cut < len(messages) {
		at = messages[cut].Time()
	}
	return fmt.Sprintf("%d:%d", cut, at)
}

func (a *Agent) fold(ctx context.Context, messages []agentcore.AgentMessage) (CompactionSummaryMessage, int, bool) {
	if EstimateTokens(messages) <= a.folding.Budget {
		return CompactionSummaryMessage{}, 0, false
	}
	cut := CutPoint(messages, a.folding.KeepRecent)
	if cut <= 0 {
		return CompactionSummaryMessage{}, 0, false
	}
	key := foldKey(messages, cut)
	a.foldMu.Lock()
	known, ok := a.folds[key]
	a.foldMu.Unlock()
	if ok {
		return known, cut, true
	}
	a.publish(AgentEvent{AgentEvent: agentcore.AgentEvent{Type: EventCompactionStart}, Reason: "threshold"})
	folding := a.folding
	if a.options.GetApiKey != nil {
		if key := a.options.GetApiKey(ctx, a.options.Model.Provider); key != "" {
			folding.StreamOptions.APIKey = key
		}
	}
	summary := Compact(ctx, messages, folding)
	a.publish(AgentEvent{AgentEvent: agentcore.AgentEvent{Type: EventCompactionEnd}, Reason: "threshold", Compaction: summary})
	if summary == nil {
		return CompactionSummaryMessage{}, 0, false
	}
	a.foldMu.Lock()
	a.folds[key] = *summary
	a.foldMu.Unlock()
	return *summary, cut, true
}

func (a *Agent) settleFold() {
	messages := a.Core.State().Messages
	summary, cut, ok := a.fold(a.ctx, messages)
	if !ok {
		return
	}
	a.foldMu.Lock()
	a.folds = map[string]CompactionSummaryMessage{}
	a.foldMu.Unlock()
	a.Core.SetMessages(append([]agentcore.AgentMessage{summary}, messages[cut:]...))
	if a.session != nil {
		_ = a.session.Append(summary)
	}
}

func (a *Agent) run(start func(ctx context.Context) error) {
	a.mu.Lock()
	a.runs++
	a.steps = 0
	a.mu.Unlock()
	go func() {
		defer func() {
			a.mu.Lock()
			a.runs--
			a.mu.Unlock()
		}()
		_ = start(a.ctx)
	}()
}

func (a *Agent) ended() {
	_ = a.Core.WaitForIdle(a.ctx)
	if a.ctx.Err() != nil {
		return
	}
	if a.Core.HasQueuedMessages() {
		a.run(a.Core.Continue)
		return
	}
	a.settleFold()
	messages := a.Core.State().Messages
	a.mu.Lock()
	// Stopped while a tool ran, the last message is that tool's result: `stopping` says it was stopped.
	aborted := a.stopping
	if len(messages) > 0 {
		if last, ok := messages[len(messages)-1].(ai.AssistantMessage); ok && last.StopReason == ai.StopAborted {
			aborted = true
		}
	}
	a.stopping = false
	waiters := a.waiters
	a.waiters = nil
	a.mu.Unlock()
	a.publish(AgentEvent{AgentEvent: agentcore.AgentEvent{Type: EventAgentSettled}, Aborted: aborted})
	for _, w := range waiters {
		close(w)
	}
}

func (a *Agent) busyRuns() int {
	a.mu.Lock()
	defer a.mu.Unlock()
	return a.runs
}

func (a *Agent) deliver(message agentcore.AgentMessage, steer bool) {
	queue := func() {
		if steer {
			a.Core.Steer(message)
		} else {
			a.Core.FollowUp(message)
		}
	}
	if a.Core.State().IsStreaming || a.busyRuns() > 0 {
		queue()
		// The run may have been ending as it came: it is not lost.
		if a.busyRuns() == 0 {
			a.run(a.Core.Continue)
		}
		return
	}
	a.run(func(ctx context.Context) error {
		err := a.Core.Prompt(ctx, message)
		if _, busy := err.(*agentcore.AgentError); busy {
			queue()
		}
		return err
	})
}

// Starts a run when idle, steers the one under way otherwise.
func (a *Agent) Send(message agentcore.AgentMessage) { a.deliver(message, true) }

// Taken when the run would stop (a follow-up); starts a run when idle.
func (a *Agent) Later(message agentcore.AgentMessage) { a.deliver(message, false) }

func (a *Agent) Ask(ctx context.Context, message agentcore.AgentMessage) (string, error) {
	settled := make(chan struct{})
	a.mu.Lock()
	a.waiters = append(a.waiters, settled)
	a.mu.Unlock()
	a.Send(message)
	select {
	case <-settled:
		return LastWords(a.Core.State().Messages), nil
	case <-ctx.Done():
		return "", ctx.Err()
	case <-a.ctx.Done():
		return "", a.ctx.Err()
	}
}

func (a *Agent) Subscribe() *agentcore.Subscription[AgentEvent] { return a.events.Subscribe() }

func (a *Agent) Busy() bool { return a.busyRuns() > 0 }

func (a *Agent) Stop() {
	a.Core.ClearAllQueues()
	if a.Core.State().IsStreaming {
		a.mu.Lock()
		a.stopping = true
		a.mu.Unlock()
	}
	a.Core.Abort()
}

func (a *Agent) History() []agentcore.AgentMessage { return a.Core.State().Messages }

// The memory stays.
func (a *Agent) Reset() error {
	a.Core.Reset()
	if a.session != nil {
		return a.session.Clear()
	}
	return nil
}

func (a *Agent) Skills() []SkillInfo { return a.skills() }

func (a *Agent) Close() {
	a.cancel()
	a.Core.Close()
	a.done.Wait()
	a.events.Close()
}
