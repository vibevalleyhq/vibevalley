package agent

// A message is saved before its message_end is passed on. Past its budget the older part of the conversation is folded into a summary: for a request
// as soon as it is too long, in the file once the run is over. The system prompt is made when the agent starts and after each fold, never per
// request: what changes meanwhile (the time, the host's situation, new memory) goes in the newest input, so the start of every request stays
// the cached one.

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
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
	EventPrefixChanged   = "prefix_changed"
)

// AgentEvent is an agentcore event, or one of this agent's own: agent_settled (Aborted), compaction_start
// (Reason "threshold"), compaction_end (Reason, Compaction: nil when nothing was folded), prefix_changed (Reason: the
// parts of the prompt's start that changed since the request before, with no compaction between, as PromptParts names
// them, joined by commas).
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
	// Applied after all built-in, host and scheduled tools have been assembled.
	DisallowedTools []string
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
	session *Session
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
	// What the last request's prompt start hashed to, per part; nil before the first request and after a compaction.
	sent map[string]string
	// The system prompt and its parts, as refreshPrefix made them.
	prefix string
	parts  []promptPart
	// The lines of MEMORY.md the model knows: the snapshot's, then as MemoryNews told it.
	knownMemory []string
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
				Name:            options.Name + "-帮手",
				Instructions:    SUBAGENT_INSTRUCTIONS(options.Name),
				Model:           options.Model,
				StreamOptions:   options.StreamOptions,
				GetApiKey:       options.GetApiKey,
				ThinkingLevel:   options.ThinkingLevel,
				Home:            options.Home,
				Cwd:             options.Cwd,
				Tools:           options.Tools,
				DisallowedTools: options.DisallowedTools,
				Skills:          skillDirs,
				NoSkills:        options.NoSkills,
				NoMemory:        true,
				MaxSteps:        30,
				NoSession:       true,
				NoSubagents:     true,
				Schedules:       new(false),
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

	a.refreshPrefix()
	var messages []agentcore.AgentMessage
	if a.session != nil {
		messages = a.session.Load()
	}
	tools := append(append([]agentcore.AgentTool{}, options.Tools...), own...)
	a.Core = agentcore.NewAgent(life, agentcore.AgentOptions{
		InitialState: agentcore.AgentInitialState{Model: options.Model, ThinkingLevel: options.ThinkingLevel, Tools: allowedTools(tools, options.DisallowedTools), Messages: messages},
		AgentLoopConfig: agentcore.AgentLoopConfig{
			StreamOptions: options.StreamOptions,
			GetApiKey:     options.GetApiKey,
			ConvertToLlm:  ConvertToLlm,
			// The fold before the prompt: a fold makes the prompt anew, and this request is the first to start with it.
			PrepareRequest: func(ctx context.Context, p agentcore.PrepareRequestContext) *agentcore.AgentRequestUpdate {
				c := p.Context
				if result := a.fold(ctx, c.Messages); result != nil {
					c.Messages = result.messages
				}
				a.foldMu.Lock()
				prefix, parts := a.prefix, a.parts
				a.foldMu.Unlock()
				c.SystemPrompt = prefix
				a.noteChanges(parts, c.Tools)
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
		a.Core.SetTools(allowedTools(append(a.Core.State().Tools, s.Tools...), options.DisallowedTools))
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

// The parts of the system prompt, in order, named instructions, env, skills, memory; an empty one is left out.
func (a *Agent) promptParts() []promptPart {
	found := a.skills()
	memory := ""
	if !a.options.NoMemory {
		memory = ReadMemory(a.options.Home)
	}
	parts := []promptPart{
		{"instructions", strings.TrimSpace(a.options.Instructions)},
		{"env", "## 环境\n- 工作目录：" + a.options.Cwd},
	}
	if len(found) > 0 {
		parts = append(parts, promptPart{"skills", "## 技能\n要用哪个先用 load_skill 读它的全文，再照着做：\n" + SkillIndex(found, 0)})
	}
	if memory != "" {
		parts = append(parts, promptPart{"memory", "## 记性（你以前记下的）\n" + memory})
	}
	return slices.DeleteFunc(parts, func(p promptPart) bool { return p.text == "" })
}

// When the agent starts and after a fold: the prompt changes only where the cache is lost anyway.
func (a *Agent) refreshPrefix() {
	parts := a.promptParts()
	var known []string
	if !a.options.NoMemory {
		known = memoryFileLines(a.options.Home)
	}
	a.foldMu.Lock()
	a.parts, a.prefix, a.knownMemory, a.sent = parts, joinParts(parts), known, nil
	a.foldMu.Unlock()
}

// What MEMORY.md gained (+) and lost (−) since the model last knew it, as one block for the newest input; "" when
// nothing. What it returns counts as known from then on.
func (a *Agent) MemoryNews() string {
	if a.options.NoMemory {
		return ""
	}
	now := memoryFileLines(a.options.Home)
	a.foldMu.Lock()
	before := a.knownMemory
	a.knownMemory = now
	a.foldMu.Unlock()
	var lines []string
	for _, l := range now {
		if !slices.Contains(before, l) {
			lines = append(lines, "+ "+l)
		}
	}
	for _, l := range before {
		if !slices.Contains(now, l) {
			lines = append(lines, "− "+l)
		}
	}
	if len(lines) == 0 {
		return ""
	}
	return "【记性有更新】\n" + strings.Join(lines, "\n")
}

func foldKey(messages []agentcore.AgentMessage, cut int) string {
	var at int64
	if cut < len(messages) {
		at = messages[cut].Time()
	}
	return fmt.Sprintf("%d:%d", cut, at)
}

func (a *Agent) fold(ctx context.Context, messages []agentcore.AgentMessage) *compacted {
	plan := planCompaction(messages, a.folding)
	if plan == nil {
		return nil
	}
	key := foldKey(messages, plan.cut)
	a.foldMu.Lock()
	known, ok := a.folds[key]
	a.foldMu.Unlock()
	if ok {
		return plan.apply(known)
	}
	a.publish(AgentEvent{AgentEvent: agentcore.AgentEvent{Type: EventCompactionStart}, Reason: "threshold"})
	folding := a.folding
	if a.options.GetApiKey != nil {
		if key := a.options.GetApiKey(ctx, a.options.Model.Provider); key != "" {
			folding.StreamOptions.APIKey = key
		}
	}
	summary := compact(ctx, *plan, folding)
	a.publish(AgentEvent{AgentEvent: agentcore.AgentEvent{Type: EventCompactionEnd}, Reason: "threshold", Compaction: summary})
	if summary == nil {
		return nil
	}
	a.foldMu.Lock()
	a.folds[key] = *summary
	a.foldMu.Unlock()
	a.refreshPrefix()
	return plan.apply(*summary)
}

func (a *Agent) settleFold() {
	messages := a.Core.State().Messages
	result := a.fold(a.ctx, messages)
	if result == nil {
		return
	}
	a.foldMu.Lock()
	a.folds = map[string]CompactionSummaryMessage{}
	a.foldMu.Unlock()
	a.Core.SetMessages(result.messages)
	if a.session != nil {
		_ = a.session.Append(result.summary)
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
	a.mu.Lock()
	done, started := a.Core.Submit(message, steer)
	if started {
		a.runs++
		a.steps = 0
	}
	a.mu.Unlock()
	if started {
		go func() {
			<-done
			a.mu.Lock()
			a.runs--
			a.mu.Unlock()
		}()
	}
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

func allowedTools(tools []agentcore.AgentTool, disallowed []string) []agentcore.AgentTool {
	return slices.DeleteFunc(tools, func(tool agentcore.AgentTool) bool { return slices.Contains(disallowed, tool.Name) })
}
