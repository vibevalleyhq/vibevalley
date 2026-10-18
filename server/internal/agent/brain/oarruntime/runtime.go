// Built on smith's runtime-author SPI the way smith's scripted runtime (oartest) is: one turn is one run of the agent until it settles.
package oarruntime

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"

	"vibevalley/internal/agent/brain"
	"vibevalley/internal/task/engine"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

const VIBEVALLEY_RUNTIME = "vibevalley"

// DeepSeek's two.
var EFFORTS = []string{"high", "max"}

const HELPER_INSTRUCTIONS = `你是一个编码 agent，在主人电脑上的一个项目目录里干活：读写代码、跑命令、查资料。
- 先弄清楚再动手：读相关的文件，看清现状；改完跑能跑的检查（lint、类型检查、测试）确认。
- 能自己查到的不问；真正要拿主意的才问，一次问清。
- 几件互不相干、各自要花工夫的事，用 spawn_agent 派帮手同时做。
- 回答用中文，简短，先说结论。`

type Options struct {
	// Default $VIBEVALLEY_HOME, else ~/.vibevalley.
	Home func() string
	// "" for the default: the session's model, else deepseek-flash, with the key saved in settings.json, else DeepSeek's own.
	Llm       func(ctx context.Context, model string) (brain.LLM, error)
	Providers []ai.ApiProvider
	// Where a session keeps its task graph; nil, it keeps none.
	Tasks func(session string) engine.Store
}

func defaultHome() string {
	if h := os.Getenv("VIBEVALLEY_HOME"); h != "" {
		return h
	}
	dir, _ := os.UserHomeDir()
	return filepath.Join(dir, ".vibevalley")
}

// Read each session: a key saved meanwhile is used.
func toMcp(s oar.McpServer) brain.McpServer {
	if s.IsHTTP() || (s.URL != "" && s.Command == "") {
		return brain.McpServer{Name: s.Name, URL: s.URL, Headers: s.Headers}
	}
	return brain.McpServer{Name: s.Name, Command: s.Command, Args: s.Args, Env: s.Env}
}

var refused = oar.RefusedSessionOptions{
	oar.OptionLaunchArgs:  "VibeValley 跑在 server 进程里，没有命令行参数",
	oar.OptionServiceTier: "DeepSeek 没有服务档位",
}

// smith's internal/shared refusableOrder, for these two.
var refusedOrder = []oar.RefusableSessionOption{oar.OptionServiceTier, oar.OptionLaunchArgs}

func VibeValleyRuntime(options Options) oar.Runtime {
	home := options.Home
	if home == nil {
		home = defaultHome
	}
	llmOf := options.Llm
	if llmOf == nil {
		llmOf = func(_ context.Context, model string) (brain.LLM, error) {
			return brain.Deepseek(model, os.Getenv("DEEPSEEK_API_KEY"))
		}
	}
	base := ai.WithProviders(context.Background(), options.Providers...)

	start := func(ctx context.Context, _ oar.AvailableInstallation, o oar.SessionOptions) (oar.Session, error) {
		for _, option := range refusedOrder {
			if o.Given(option) {
				return nil, &oar.UnsupportedOptionError{Option: string(option), Message: refused[option]}
			}
		}
		if o.Effort != "" && !contains(EFFORTS, o.Effort) {
			return nil, fmt.Errorf("%s 只有 %s 两档思考强度，没有「%s」", VIBEVALLEY_RUNTIME, strings.Join(EFFORTS, "、"), o.Effort)
		}
		llm, err := llmOf(ctx, o.Model)
		if err != nil {
			return nil, err
		}
		s := &session{kernel: kernel.New(o.Resume), llm: llm}
		life, cancel := context.WithCancel(base)
		s.cancel = cancel

		servers := make([]brain.McpServer, 0, len(o.MCPServers))
		for _, m := range o.MCPServers {
			servers = append(servers, toMcp(m))
		}
		tools := brain.CodingTools(brain.CodingOptions{Cwd: o.Cwd, Env: o.Env})
		instructions := ""
		if o.SystemPrompt != nil {
			instructions = *o.SystemPrompt
		} else {
			parts := []string{HELPER_INSTRUCTIONS}
			if o.AppendSystemPrompt != nil && *o.AppendSystemPrompt != "" {
				parts = append(parts, *o.AppendSystemPrompt)
			}
			instructions = strings.Join(parts, "\n\n")
		}
		var tasks engine.Store
		if options.Tasks != nil {
			tasks = options.Tasks(s.kernel.SessionID())
		}
		s.agent = brain.NewAgent(life, brain.AgentOptions{
			Name:            "worker",
			Instructions:    instructions,
			Model:           llm.Model,
			StreamOptions:   llm.StreamOptions,
			ThinkingLevel:   o.Effort,
			Home:            filepath.Join(home(), "workers"),
			Cwd:             o.Cwd,
			Tools:           tools,
			DisallowedTools: o.DisallowedTools,
			McpServers:      servers,
			NoMemory:        true,
			Session:         s.kernel.SessionID(),
			Schedules:       new(false),
			Tasks:           tasks,
		})
		// Listening before the first input.
		events := s.agent.Subscribe()
		s.listening.Add(1)
		go func() {
			defer s.listening.Done()
			for e := range events.C {
				s.said(e)
			}
		}()
		s.events = events

		s.mu.Lock()
		s.frame("vibevalley/model", map[string]any{"model": llm.Model.ID}, oar.Model{Model: llm.Model.ID})
		if o.Effort != "" {
			s.frame("vibevalley/effort", map[string]any{"effort": o.Effort}, oar.Effort{Effort: o.Effort})
		}
		s.mu.Unlock()
		return kernel.Seal(s), nil
	}

	return oar.DefineRuntime(oar.Runtime{
		ID:                    VIBEVALLEY_RUNTIME,
		Session:               start,
		RefusedSessionOptions: refused,
		Installation: func(ctx context.Context, _ oar.InstallationOptions) (oar.InstallationSnapshot, error) {
			if _, err := llmOf(ctx, ""); err != nil {
				return oar.InstallationSnapshot{Kind: "unsupported", Reason: err.Error()}, nil
			}
			return oar.Available(oar.AvailableInstallation{Via: "bundled"}), nil
		},
		ListModels: func(context.Context, oar.AvailableInstallation, oar.ListModelsOptions) (oar.ListModelsResult, error) {
			models := make([]oar.ModelEntry, 0, len(ai.MODELS))
			for _, m := range ai.MODELS {
				models = append(models, oar.ModelEntry{ID: m.ID, DisplayName: m.Name, EffortLevels: append([]string(nil), EFFORTS...), Default: m.ID == brain.DEFAULT_MODEL})
			}
			return oar.ListModelsResult{Kind: "ok", Models: models}, nil
		},
	})
}

var VibeValley = VibeValleyRuntime(Options{})

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

type queued struct {
	input   string
	inputID string
}

func (q queued) HeldInputID() string { return q.inputID }

// mu guards everything below it; agent events are handled under it, one at a time, on the subscription's goroutine.
type session struct {
	kernel    *kernel.Kernel
	llm       brain.LLM
	agent     *brain.Agent
	events    *agentcore.Subscription[brain.AgentEvent]
	cancel    context.CancelFunc
	listening sync.WaitGroup

	mu       sync.Mutex
	active   bool
	disposed bool
	queue    []queued
}

var capabilities = oar.SessionCapabilities{QueueDurable: false, Attribution: "none", Images: false}

func (s *session) frame(kind string, native any, events ...oar.EventBody) {
	raw, _ := json.Marshal(native)
	s.kernel.Frame(oar.FrameBody{Type: kind, Native: raw, Events: events}, kernel.RecordAt{})
}

// Called with s.mu held.
func (s *session) begin(input string) {
	s.active = true
	s.agent.Send(brain.UserMessage(input))
}

// Called with s.mu held.
func (s *session) end(outcome oar.TurnOutcome, progress brain.RunSnapshot) {
	if !s.active {
		return
	}
	s.active = false
	window := int64(s.llm.Model.ContextWindow)
	tokens := int64(progress.Current.ContextTokens)
	percent := 0.0
	if window > 0 {
		percent = float64(tokens) / float64(window) * 100
	}
	cacheRead, cacheWrite := int64(progress.Lifetime.CacheRead), int64(progress.Lifetime.CacheWrite)
	s.frame("vibevalley/end", map[string]any{"outcome": outcome},
		oar.TurnEnded{Outcome: outcome},
		oar.Usage{Usage: oar.UsageReport{
			Tokens:  &oar.TokenTotals{Input: int64(progress.Lifetime.Input), Output: int64(progress.Lifetime.Output), CacheRead: &cacheRead, CacheWrite: &cacheWrite},
			Context: &oar.ContextUsage{Tokens: &tokens, ContextWindow: &window, Percent: &percent},
		}})
	if len(s.queue) > 0 && !s.disposed {
		next := s.queue[0]
		s.queue = s.queue[1:]
		s.begin(next.input)
	}
}

func (s *session) said(e brain.AgentEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.disposed {
		return
	}
	switch e := e.(type) {
	case agentcore.MessageUpdated:
		d := e.Delta
		if d.Type == ai.EventTextDelta {
			s.frame("vibevalley/text", map[string]any{"text": d.Delta}, oar.TextDelta{Text: d.Delta})
		}
		if d.Type == ai.EventThinkingEnd && d.Content != "" {
			s.frame("vibevalley/reasoning", map[string]any{"text": d.Content}, oar.Reasoning{Content: oar.ReasoningContent{Kind: "text", Text: d.Content}})
		}
	case agentcore.ToolStarted:
		input := string(e.Args)
		if input == "" {
			input = "{}"
		}
		s.frame("vibevalley/tool_start", map[string]any{"callId": e.ToolCallID, "name": e.ToolName, "input": input},
			oar.ToolCallStarted{CallID: e.ToolCallID, Tool: e.ToolName, Input: &input})
	case agentcore.ToolEnded:
		text := agentcore.ResultText(e.Result.Content)
		result := "ok"
		if e.IsError {
			result = "failed"
		}
		s.frame("vibevalley/tool_end", map[string]any{"callId": e.ToolCallID, "output": text, "result": result},
			oar.ToolCallEnded{CallID: e.ToolCallID, Result: result, Content: []oar.ToolOutputPart{{Type: "text", Text: text}}})
	case brain.CompactionStarted:
		s.frame("vibevalley/compaction", map[string]any{"phase": "start"}, oar.CompactionStarted{Trigger: e.Reason})
	case brain.CompactionEnded:
		outcome := "failed"
		if e.Compaction != nil {
			outcome = "completed"
		}
		s.frame("vibevalley/compaction", map[string]any{"phase": "end"}, oar.CompactionEnded{Outcome: outcome, Trigger: e.Reason})
	case brain.TasksChanged:
		// oar has no event for a task: the graph goes in the raw record, where the session's trajectory keeps it.
		s.frame("vibevalley/tasks", map[string]any{"tasks": e.Tasks})
	case brain.AgentSettled:
		switch {
		case e.Run.Aborted:
			s.end(oar.AbortedOutcome(), s.agent.Progress())
		case e.Run.Error != "":
			s.end(oar.Failed(oar.FailureUnknown, e.Run.Error), s.agent.Progress())
		default:
			s.end(oar.Completed(), s.agent.Progress())
		}
	}
}

func (s *session) ID() string                            { return s.kernel.SessionID() }
func (s *session) Capabilities() oar.SessionCapabilities { return capabilities }

func inputBody(kind oar.RequestKind, input string, options oar.InputOptions) oar.RequestBody {
	return oar.RequestBody{Kind: kind, Input: input, InputID: options.InputID, Images: options.Images, Origin: options.Origin}
}

func (s *session) Prompt(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kernel.Control(inputBody(oar.RequestPrompt, input, options), func(oar.RawEvent) (oar.ResponseBody, error) {
		if s.active {
			return oar.Rejected(oar.CodeBusy, "busy"), nil
		}
		if refused := kernel.InputImagesRefusal(capabilities.Images, options.Images); refused != nil {
			return *refused, nil
		}
		s.begin(input)
		return oar.Accepted(), nil
	}, kernel.RecordAt{}), nil
}

func (s *session) Steer(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kernel.Control(inputBody(oar.RequestSteer, input, options), func(oar.RawEvent) (oar.ResponseBody, error) {
		if !s.active {
			return oar.Rejected(oar.CodeNoActiveTurn, "no active turn"), nil
		}
		if refused := kernel.InputImagesRefusal(capabilities.Images, options.Images); refused != nil {
			return *refused, nil
		}
		s.agent.Send(brain.UserMessage(input))
		return oar.Accepted(), nil
	}, kernel.RecordAt{}), nil
}

func (s *session) Queue(_ context.Context, input string, options oar.InputOptions) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kernel.Control(inputBody(oar.RequestQueue, input, options), func(oar.RawEvent) (oar.ResponseBody, error) {
		if refused := kernel.InputImagesRefusal(capabilities.Images, options.Images); refused != nil {
			return *refused, nil
		}
		if s.active {
			s.queue = append(s.queue, queued{input: input, inputID: options.InputID})
		} else {
			s.begin(input)
		}
		return oar.Accepted(), nil
	}, kernel.RecordAt{}), nil
}

func (s *session) Withdraw(_ context.Context, inputID string) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// The turn-end drain takes its entry off before running it, so an entry still here was never sent.
	return s.kernel.Control(oar.RequestBody{Kind: oar.RequestWithdraw, InputID: inputID}, func(oar.RawEvent) (oar.ResponseBody, error) {
		return kernel.WithdrawHeld(&s.queue, inputID), nil
	}, kernel.RecordAt{}), nil
}

func (s *session) Abort(context.Context) (oar.ControlResult, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.kernel.Control(oar.RequestBody{Kind: oar.RequestAbort}, func(oar.RawEvent) (oar.ResponseBody, error) {
		if !s.active {
			return oar.Rejected(oar.CodeNoActiveTurn, "no active turn"), nil
		}
		// The turn ends `aborted` when the agent has stopped (agent_settled).
		go s.agent.Stop()
		return oar.Accepted(), nil
	}, kernel.RecordAt{}), nil
}

func (s *session) RawEvents(observer oar.RawEventObserver, cursor *oar.Cursor) oar.Unsubscribe {
	return s.kernel.RawEvents(observer, cursor)
}

func (s *session) Records() []oar.RawEvent { return s.kernel.Records() }
func (s *session) Graph() oar.SessionGraph { return s.kernel.Graph() }

func (s *session) Dispose(context.Context) error {
	s.mu.Lock()
	if s.disposed {
		s.mu.Unlock()
		return nil
	}
	request := s.kernel.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestDispose}, kernel.RecordAt{})
	s.queue = nil
	s.disposed = true
	s.mu.Unlock()
	s.agent.Stop()
	s.agent.Close()
	s.events.Close()
	s.listening.Wait()
	s.mu.Lock()
	s.end(oar.AbortedOutcome(), s.agent.Progress())
	s.mu.Unlock()
	s.cancel()
	code := 0
	s.kernel.Respond(request.ID, oar.ExitedBody(&code), kernel.RecordAt{})
	return nil
}
