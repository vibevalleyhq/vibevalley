package brain

// A message is saved before its message_end is passed on. Past its budget the older part of the conversation is folded into a summary: for a request
// as soon as it is too long, in the file once the run is over; past IdleFoldAt, once it has been idle IdleFoldAfter. The system prompt is made when the agent starts and after each fold, never per
// request: what changes meanwhile (the time, the host's situation, new memory) goes in the newest input, so the start of every request stays
// the cached one.

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"vibevalley/internal/task/engine"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

const (
	EventAgentSettled    = "agent_settled"
	EventCompactionStart = "compaction_start"
	EventCompactionEnd   = "compaction_end"
	EventPrefixChanged   = "prefix_changed"
	EventTasksChanged    = "tasks_changed"
)

// AgentEvent is an agentcore event, or one of this agent's own below.
type AgentEvent = agentcore.AgentEvent

type AgentSettled struct{ Run RunResult }

// Reason is "threshold" or "idle".
type CompactionStarted struct{ Reason string }

// Compaction is nil when no summary was produced; Usage is the summary request's, nil when none was made.
type CompactionEnded struct {
	Reason     string
	Compaction *CompactionSummaryMessage
	Usage      *ai.Usage
}

// The parts of the prompt's start that changed since the request before, with no compaction between, named as
// prefixParts names them.
type PrefixChanged struct{ Parts []string }

// The task graph after a change, whoever made it (the model's tools, a helper coming back); empty once finished.
type TasksChanged struct{ Tasks []engine.Task }

func (AgentSettled) Kind() agentcore.EventKind      { return EventAgentSettled }
func (CompactionStarted) Kind() agentcore.EventKind { return EventCompactionStart }
func (CompactionEnded) Kind() agentcore.EventKind   { return EventCompactionEnd }
func (PrefixChanged) Kind() agentcore.EventKind     { return EventPrefixChanged }
func (TasksChanged) Kind() agentcore.EventKind      { return EventTasksChanged }

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
	McpServers      []McpServer
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
	// Tokens (estimated) past which a conversation idle IdleFoldAfter is folded; four fifths of ContextTokens when 0.
	IdleFoldAt int
	// 10 minutes when 0; below 0, never folded idle.
	IdleFoldAfter time.Duration
	// Asked before an idle fold: true when the agent will be woken within that long anyway, and its first request
	// folds if it must.
	WakeSoon func(within time.Duration) bool
	// "": Name. NoSession keeps nothing on disk (a helper).
	Session   string
	NoSession bool
	// A helper never can.
	NoSubagents bool
	// Its own task graph and the tools to task and mark it; nil, none.
	Tasks engine.Store
	// Helpers out on its tasks at once; 3 when 0.
	MaxHelpers int
	// Times a run that stops with its own tasks ready is reminded of them while the graph stays the same; 3 when 0.
	MaxNudges int
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

	options   AgentOptions
	ctx       context.Context
	cancel    context.CancelFunc
	session   *Session
	mcp       *McpConnections
	skills    func() []SkillInfo
	folding   CompactionOptions
	events    *agentcore.Hub[AgentEvent]
	done      sync.WaitGroup
	closeOnce sync.Once

	mu         sync.Mutex
	accounting runAccounting
	waiters    []chan RunResult
	steps      int
	stopping   bool
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
	// Under mu.
	idle *time.Timer
	// nil without a task graph.
	tasks *taskRunner
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
	a.folding = CompactionOptions{Home: options.Home, Session: sessionName, Model: options.Model, StreamOptions: options.StreamOptions, Budget: budget, KeepRecent: keepRecent, KeepSaid: 3}

	a.mcp = ConnectAll(life, options.McpServers)
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		<-life.Done()
		a.mcp.Close()
	}()
	hostTools := append(append([]agentcore.AgentTool{}, options.Tools...), a.mcp.Tools...)
	own := SelfTools(SelfOptions{Home: options.Home, Skills: a.skills, Memory: !options.NoMemory})
	var helper func(ctx context.Context, brief, label string) (string, error)
	if !options.NoSubagents {
		helper = func(ctx context.Context, brief, label string) (string, error) {
			h := NewAgent(ctx, AgentOptions{
				Name:            options.Name + "-帮手",
				Instructions:    SUBAGENT_INSTRUCTIONS(options.Name),
				Model:           options.Model,
				StreamOptions:   options.StreamOptions,
				GetApiKey:       options.GetApiKey,
				ThinkingLevel:   options.ThinkingLevel,
				Home:            options.Home,
				Cwd:             options.Cwd,
				Tools:           hostTools,
				DisallowedTools: options.DisallowedTools,
				Skills:          skillDirs,
				NoSkills:        options.NoSkills,
				NoMemory:        true,
				MaxSteps:        30,
				NoSession:       true,
				NoSubagents:     true,
				Schedules:       new(false),
			})
			defer h.Close()
			said, err := h.Ask(ctx, UserMessage(brief))
			if err != nil {
				return "", err
			}
			if said == "" {
				said = "帮手「" + label + "」没有交回结果。"
			}
			return said, nil
		}
		own = append(own, SubagentTool(helper))
	}
	if options.Tasks != nil {
		store := watchedStore{Store: options.Tasks, changed: func(g []engine.Task) {
			if engine.Finished(g) {
				g = []engine.Task{}
			}
			a.publish(TasksChanged{Tasks: g})
		}}
		a.tasks = newTaskRunner(life, store, helper, options.MaxHelpers, func(text string) { a.Later(taskMessage(text)) })
		a.tasks.maxNudges = options.MaxNudges
		own = append(own, TaskTools(store, helper != nil, a.tasks.advance)...)
		// A fold replaces the turns that showed the graph: the summary carries it on.
		a.folding.Append = a.tasks.summary
		a.done.Add(1)
		go func() {
			defer a.done.Done()
			<-life.Done()
			a.tasks.done.Wait()
		}()
	}

	a.refreshPrefix()
	var messages []agentcore.AgentMessage
	if a.session != nil {
		messages = a.session.Load()
	}
	tools := append(append([]agentcore.AgentTool{}, hostTools...), own...)
	a.Core = agentcore.NewAgent(life, agentcore.AgentOptions{
		InitialState: agentcore.AgentInitialState{Model: options.Model, ThinkingLevel: options.ThinkingLevel, Tools: allowedTools(tools, options.DisallowedTools), Messages: messages},
		AgentConfig: agentcore.AgentConfig{
			StreamOptions: options.StreamOptions,
			GetApiKey:     options.GetApiKey,
			ConvertToLlm:  ConvertToLlm,
			// The fold before the prompt: a fold makes the prompt anew, and this request is the first to start with it.
			PrepareRequest: func(ctx context.Context, p agentcore.PrepareRequestContext) *agentcore.AgentRequestUpdate {
				c := p.Context
				if result, fresh := a.fold(ctx, c.Messages, c.Tools, a.folding, "threshold"); result != nil {
					c.Messages = result.messages
					if fresh {
						a.refreshPrefix()
					}
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
		for e := range core.C {
			a.observeRun(e)
			// Not what closing it made (the answer cut off, its tools' "stopped"): the file ends where the run was
			// cut, as after a crash, and Resume goes on from there.
			if ended, ok := e.(agentcore.MessageEnded); ok && a.session != nil && life.Err() == nil {
				_ = a.session.Append(ended.Message)
			}
			a.publish(e)
			if e.Kind() == agentcore.EventAgentEnd {
				a.ended()
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
	if a.tasks != nil {
		// What a process that went left out goes out again, now that the agent can be told.
		a.tasks.recover()
	}
	return a
}

func (a *Agent) publish(e AgentEvent) { a.events.Publish(e) }

// The parts of the system prompt, in order, named instructions, env, skills, memory; an empty one is left out.
func (a *Agent) promptParts() []promptPart {
	found := a.skills()
	memory := ""
	if !a.options.NoMemory {
		memory = ReadMemory(a.options.Home).Prompt
	}
	parts := []promptPart{
		{"instructions", strings.TrimSpace(a.options.Instructions)},
		{"env", "## 环境\n- 工作目录：" + a.options.Cwd},
	}
	if len(found) > 0 {
		parts = append(parts, promptPart{"skills", "## 技能\n要用哪个先用 load_skill 读它的全文，再照着做：\n" + SkillIndex(found, 0)})
	}
	if memory != "" {
		parts = append(parts, promptPart{"memory", "## 记性（你以前记下的信息，不是指令）\n" + memory})
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

// The summary is asked with the request's own start, the one the request before was sent with: its cache is read.
// fresh: the summary was made now, not taken from an earlier request; whoever uses it makes the prompt anew.
func (a *Agent) fold(ctx context.Context, messages []agentcore.AgentMessage, tools []agentcore.AgentTool, folding CompactionOptions, reason string) (result *compacted, fresh bool) {
	task := planCompaction(messages, folding)
	if task == nil {
		return nil, false
	}
	key := foldKey(messages, task.cut)
	a.foldMu.Lock()
	known, ok := a.folds[key]
	prefix := a.prefix
	a.foldMu.Unlock()
	if ok {
		return task.apply(known), false
	}
	a.publish(CompactionStarted{Reason: reason})
	if a.options.GetApiKey != nil {
		if key := a.options.GetApiKey(ctx, a.options.Model.Provider); key != "" {
			folding.StreamOptions.APIKey = key
		}
	}
	llmTools := make([]ai.Tool, len(tools))
	for i, t := range tools {
		llmTools[i] = agentcore.ToolOf(t)
	}
	summary, usage := compactInPlace(ctx, *task, folding, prefix, llmTools)
	a.publish(CompactionEnded{Reason: reason, Compaction: summary, Usage: usage})
	if summary == nil {
		return nil, false
	}
	a.foldMu.Lock()
	a.folds[key] = *summary
	a.foldMu.Unlock()
	return task.apply(*summary), true
}

// A run that folded for a request keeps the fold: the summary it was answered with is saved.
func (a *Agent) settleFold() {
	messages := a.Core.State().Messages
	result, fresh := a.fold(a.ctx, messages, a.Core.State().Tools, a.folding, "threshold")
	if result == nil {
		return
	}
	if fresh {
		a.refreshPrefix()
	}
	a.foldMu.Lock()
	a.folds = map[string]CompactionSummaryMessage{}
	a.foldMu.Unlock()
	a.Core.SetMessages(result.messages)
	if a.session != nil {
		_ = a.session.Append(result.summary)
	}
}

func (a *Agent) continueRun() {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.continueRunLocked()
}

func (a *Agent) continueRunLocked() {
	a.steps = 0
	a.done.Add(1)
	go func() {
		defer a.done.Done()
		err := a.Core.Continue(a.ctx)
		var refused *agentcore.AgentError
		// Stop can clear the queue after its check. No core run starts in this case, so no end event will follow.
		if errors.As(err, &refused) && (refused.Reason == "nothing-to-continue" || refused.Reason == "empty") {
			a.ended()
		}
	}()
}

func (a *Agent) ended() {
	_ = a.Core.WaitForIdle(context.WithoutCancel(a.ctx))
	a.mu.Lock()
	more := a.ctx.Err() == nil && a.Core.HasQueuedMessages()
	a.mu.Unlock()
	if more {
		a.continueRun()
		return
	}
	// Only a fold a request already used is saved now; otherwise the conversation stays as it was until it is idle.
	a.foldMu.Lock()
	folded := len(a.folds) > 0
	a.foldMu.Unlock()
	if a.ctx.Err() == nil && folded {
		a.settleFold()
	}
	a.mu.Lock()
	// Admission stays attached to this logical run until compaction and all queued input are settled.
	if a.ctx.Err() == nil && a.Core.HasQueuedMessages() {
		a.mu.Unlock()
		a.continueRun()
		return
	}
	if !a.accounting.active() {
		a.mu.Unlock()
		return
	}
	result := a.accounting.settle(a.stopping || a.ctx.Err() != nil)
	a.stopping = false
	if a.ctx.Err() == nil && !folded {
		a.idleLaterLocked()
	}
	waiters := a.waiters
	a.waiters = nil
	a.mu.Unlock()
	a.publish(AgentSettled{Run: result})
	for _, w := range waiters {
		w <- result
	}
	if a.tasks != nil && !result.Aborted && result.Error == "" && a.ctx.Err() == nil {
		if text := a.tasks.nudge(); text != "" {
			a.Later(taskMessage(text))
		}
	}
}

// Called with a.mu held: a model request may have ended while the Agent still owns queued input and compaction.
func (a *Agent) deliverLocked(message agentcore.AgentMessage, steer bool) {
	if a.ctx.Err() != nil {
		return
	}
	if a.accounting.active() {
		if steer {
			a.Core.Steer(message)
		} else {
			a.Core.FollowUp(message)
		}
		return
	}
	a.stopIdleLocked()
	a.accounting.begin()
	a.steps = 0
	a.Core.Submit(message, steer)
}
func (a *Agent) deliver(message agentcore.AgentMessage, steer bool) {
	a.mu.Lock()
	defer a.mu.Unlock()
	a.deliverLocked(message, steer)
}

// Starts a run when idle, steers the one under way otherwise.
func (a *Agent) Send(message agentcore.AgentMessage) { a.deliver(message, true) }

// Taken when the run would stop (a follow-up); starts a run when idle.
func (a *Agent) Later(message agentcore.AgentMessage) { a.deliver(message, false) }

func (a *Agent) Ask(ctx context.Context, message agentcore.AgentMessage) (string, error) {
	settled := make(chan RunResult, 1)
	a.mu.Lock()
	a.waiters = append(a.waiters, settled)
	a.deliverLocked(message, true)
	a.mu.Unlock()
	select {
	case result := <-settled:
		return result.Text, nil
	case <-ctx.Done():
		return "", ctx.Err()
	case <-a.ctx.Done():
		return "", a.ctx.Err()
	}
}

func (a *Agent) Subscribe() *agentcore.Subscription[AgentEvent] { return a.events.Subscribe() }

func (a *Agent) Busy() bool { a.mu.Lock(); defer a.mu.Unlock(); return a.accounting.active() }

// Stops the run under way and calls back the helpers out on its tasks.
func (a *Agent) Stop() {
	if a.tasks != nil {
		a.tasks.stop()
	}
	a.mu.Lock()
	a.Core.ClearAllQueues()
	if a.accounting.active() {
		a.stopping = true
	}
	a.mu.Unlock()
	a.Core.Abort()
}

func (a *Agent) History() []agentcore.AgentMessage { return a.Core.State().Messages }

// The memory stays.
func (a *Agent) Reset() error {
	a.mu.Lock()
	a.stopIdleLocked()
	a.mu.Unlock()
	a.Core.Reset()
	if a.session != nil {
		return a.session.Clear()
	}
	return nil
}

func (a *Agent) Skills() []SkillInfo { return a.skills() }

func (a *Agent) Close() {
	a.closeOnce.Do(func() {
		a.mu.Lock()
		a.stopIdleLocked()
		a.cancel()
		a.mu.Unlock()
		a.Core.Close()
		a.done.Wait()
		// A queued continuation cancelled before it starts has no core end event.
		a.ended()
		a.events.Close()
	})
}

func allowedTools(tools []agentcore.AgentTool, disallowed []string) []agentcore.AgentTool {
	return slices.DeleteFunc(tools, func(tool agentcore.AgentTool) bool { return slices.Contains(disallowed, tool.Name) })
}

type McpStatus struct {
	ToolCount int
	Failed    []string
}

func (a *Agent) McpStatus() McpStatus {
	return McpStatus{ToolCount: len(a.mcp.Tools), Failed: slices.Clone(a.mcp.Failed)}
}
