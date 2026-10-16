// Package oarruntime is vibevalley's own agent as an oar runtime (`vibevalley`), so a helper can be one: the agent package
// with the coding tools in the helper's folder, the session's MCP servers (the farm's /mcp tools among them) and
// DeepSeek, in this process. Ported from the TypeScript server's vibevalley-runtime.ts (removed), built on smith's runtime-author SPI the
// way smith's scripted runtime (oartest) is: one turn is one run of the agent until it settles; what it says,
// thinks and runs becomes the ordinary events (text_delta, reasoning, tool_call_*, turn_ended, usage). Steer joins
// the run under way; queued inputs wait for the turn to end and can be withdrawn until then. The conversation is
// kept as <home>/helpers/<session id>.jsonl, so a resumed session goes on.
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
	"vibevalley/pkg/smith/runtimes/defaults"

	"vibevalley/pkg/agent"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

const VIBEVALLEY_RUNTIME = "vibevalley"

// EFFORTS is the levels of thinking a helper can be asked for: DeepSeek's two.
var EFFORTS = []string{"high", "max"}

// HELPER_INSTRUCTIONS is who a helper is, before the farm's persona (appended) or instead of it (a replaced system prompt).
const HELPER_INSTRUCTIONS = `你是一个编码 agent，在主人电脑上的一个项目目录里干活：读写代码、跑命令、查资料。
- 先弄清楚再动手：读相关的文件，看清现状；改完跑能跑的检查（lint、类型检查、测试）确认。
- 能自己查到的不问；真正要拿主意的才问，一次问清。
- 几件互不相干、各自要花工夫的事，用 spawn_agent 派帮手同时做。
- 回答用中文，简短，先说结论。`

type Options struct {
	// vibevalley's folder: the conversations are under helpers/. Default $VIBEVALLEY_HOME, else ~/.vibevalley.
	Home func() string
	// The model and its key for a session ("" for the default); default DeepSeek (the session's model, else
	// deepseek-flash) with the key saved in settings.json, else DeepSeek's own.
	Llm func(ctx context.Context, model string) (agent.LLM, error)
	// Providers besides the default ones (a test's faux).
	Providers []ai.ApiProvider
}

func defaultHome() string {
	if h := os.Getenv("VIBEVALLEY_HOME"); h != "" {
		return h
	}
	dir, _ := os.UserHomeDir()
	return filepath.Join(dir, ".vibevalley")
}

// settingsKey is the DeepSeek key saved from the title screen (<home>/settings.json), read each session: a key
// saved meanwhile is used.
func settingsKey(home string) string {
	data, err := os.ReadFile(filepath.Join(home, "settings.json"))
	if err != nil {
		return ""
	}
	var settings struct {
		DeepseekAPIKey string `json:"deepseekApiKey"`
	}
	_ = json.Unmarshal(data, &settings)
	return settings.DeepseekAPIKey
}

func toMcp(s oar.McpServer) agent.McpServer {
	if s.IsHTTP() || (s.URL != "" && s.Command == "") {
		return agent.McpServer{Name: s.Name, URL: s.URL, Headers: s.Headers}
	}
	return agent.McpServer{Name: s.Name, Command: s.Command, Args: s.Args, Env: s.Env}
}

var refused = oar.RefusedSessionOptions{
	oar.OptionLaunchArgs:  "VibeValley 跑在 server 进程里，没有命令行参数",
	oar.OptionServiceTier: "DeepSeek 没有服务档位",
}

// refusedOrder is the order options are checked in (smith's internal/shared refusableOrder, for these two).
var refusedOrder = []oar.RefusableSessionOption{oar.OptionServiceTier, oar.OptionLaunchArgs}

// VibeValleyRuntime is the runtime.
func VibeValleyRuntime(options Options) oar.Runtime {
	home := options.Home
	if home == nil {
		home = defaultHome
	}
	llmOf := options.Llm
	if llmOf == nil {
		llmOf = func(_ context.Context, model string) (agent.LLM, error) {
			return agent.Deepseek(model, settingsKey(home()))
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

		servers := make([]agent.McpServer, 0, len(o.MCPServers))
		for _, m := range o.MCPServers {
			servers = append(servers, toMcp(m))
		}
		s.mcp = agent.ConnectAll(life, servers)
		disallowed := map[string]bool{}
		for _, name := range o.DisallowedTools {
			disallowed[name] = true
		}
		var tools []agentcore.AgentTool
		for _, t := range append(agent.CodingTools(agent.CodingOptions{Cwd: o.Cwd, Env: o.Env}), s.mcp.Tools...) {
			if !disallowed[t.Name] {
				tools = append(tools, t)
			}
		}
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
		s.agent = agent.NewAgent(life, agent.AgentOptions{
			Name:          "helper",
			Instructions:  instructions,
			Model:         llm.Model,
			StreamOptions: llm.StreamOptions,
			ThinkingLevel: o.Effort,
			Home:          filepath.Join(home(), "helpers"),
			Cwd:           o.Cwd,
			Tools:         tools,
			NoMemory:      true,
			Session:       s.kernel.SessionID(),
			Schedules:     new(false),
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
		// Nothing to install: it is in this process. Usable when there is a DeepSeek key (the environment, or pi's).
		Installation: func(ctx context.Context) (oar.InstallationSnapshot, error) {
			if _, err := llmOf(ctx, ""); err != nil {
				return oar.InstallationSnapshot{Kind: "unsupported", Reason: err.Error()}, nil
			}
			return oar.Available(oar.AvailableInstallation{Via: "bundled"}), nil
		},
		ListModels: func(context.Context, oar.AvailableInstallation, oar.ListModelsOptions) (oar.ListModelsResult, error) {
			models := make([]oar.ModelEntry, 0, len(ai.MODELS))
			for _, m := range ai.MODELS {
				models = append(models, oar.ModelEntry{ID: m.ID, DisplayName: m.Name, EffortLevels: append([]string(nil), EFFORTS...), Default: m.ID == agent.DefaultModelID()})
			}
			return oar.ListModelsResult{Kind: "ok", Models: models}, nil
		},
	})
}

// VibeValley is the runtime vibevalley runs helpers on by default.
var VibeValley = VibeValleyRuntime(Options{})

// RuntimeOf is a runtime by id: vibevalley's own, or one of smith's.
func RuntimeOf(id string) (oar.Runtime, bool) {
	if id == VIBEVALLEY_RUNTIME {
		return VibeValley, true
	}
	return defaults.Registry().Get(id)
}

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

// session is one helper's session. mu guards everything below it; agent events are handled under it, one at a
// time, on the subscription's goroutine.
type session struct {
	kernel    *kernel.Kernel
	llm       agent.LLM
	agent     *agent.Agent
	mcp       *agent.McpConnections
	events    *agentcore.Subscription[agent.AgentEvent]
	cancel    context.CancelFunc
	listening sync.WaitGroup

	mu sync.Mutex
	// A turn under way, and the inputs waiting for it to end.
	active   bool
	disposed bool
	queue    []queued
	totals   oar.TokenTotals
	cacheR   int64
	cacheW   int64
	context  int64
	failed   string
}

var capabilities = oar.SessionCapabilities{QueueDurable: false, Attribution: "none", Images: false}

func (s *session) frame(kind string, native any, events ...oar.EventBody) {
	raw, _ := json.Marshal(native)
	s.kernel.Frame(oar.FrameBody{Type: kind, Native: raw, Events: events}, kernel.RecordAt{})
}

// begin starts a turn (s.mu held).
func (s *session) begin(input string) {
	s.active = true
	s.failed = ""
	s.agent.Send(agent.UserMessage(input))
}

// end ends the turn under way with outcome, then begins the next queued one (s.mu held).
func (s *session) end(outcome oar.TurnOutcome) {
	if !s.active {
		return
	}
	s.active = false
	window := int64(s.llm.Model.ContextWindow)
	tokens := s.context
	percent := 0.0
	if window > 0 {
		percent = float64(tokens) / float64(window) * 100
	}
	cacheRead, cacheWrite := s.cacheR, s.cacheW
	s.frame("vibevalley/end", map[string]any{"outcome": outcome},
		oar.TurnEnded{Outcome: outcome},
		oar.Usage{Usage: oar.UsageReport{
			Tokens:  &oar.TokenTotals{Input: s.totals.Input, Output: s.totals.Output, CacheRead: &cacheRead, CacheWrite: &cacheWrite},
			Context: &oar.ContextUsage{Tokens: &tokens, ContextWindow: &window, Percent: &percent},
		}})
	if len(s.queue) > 0 && !s.disposed {
		next := s.queue[0]
		s.queue = s.queue[1:]
		s.begin(next.input)
	}
}

func (s *session) said(e agent.AgentEvent) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.disposed {
		return
	}
	switch e.Type {
	case agentcore.EventMessageUpdate:
		d := e.AssistantMessageEvent
		if d.Type == ai.EventTextDelta {
			s.frame("vibevalley/text", map[string]any{"text": d.Delta}, oar.TextDelta{Text: d.Delta})
		}
		if d.Type == ai.EventThinkingEnd && d.Content != "" {
			s.frame("vibevalley/reasoning", map[string]any{"text": d.Content}, oar.Reasoning{Content: oar.ReasoningContent{Kind: "text", Text: d.Content}})
		}
	case agentcore.EventMessageEnd:
		m, ok := e.Message.(ai.AssistantMessage)
		if !ok {
			return
		}
		s.totals.Input += int64(m.Usage.Input)
		s.totals.Output += int64(m.Usage.Output)
		s.cacheR += int64(m.Usage.CacheRead)
		s.cacheW += int64(m.Usage.CacheWrite)
		s.context = int64(m.Usage.Input + m.Usage.CacheRead + m.Usage.Output)
		if m.StopReason == ai.StopError {
			s.failed = m.ErrorMessage
			if s.failed == "" {
				s.failed = "模型出错了"
			}
		}
	case agentcore.EventToolExecutionStart:
		input := string(e.Args)
		if input == "" {
			input = "{}"
		}
		s.frame("vibevalley/tool_start", map[string]any{"callId": e.ToolCallID, "name": e.ToolName, "input": input},
			oar.ToolCallStarted{CallID: e.ToolCallID, Tool: e.ToolName, Input: &input})
	case agentcore.EventToolExecutionEnd:
		text := agentcore.ResultText(e.Result.Content)
		result := "ok"
		if e.IsError {
			result = "failed"
		}
		s.frame("vibevalley/tool_end", map[string]any{"callId": e.ToolCallID, "output": text, "result": result},
			oar.ToolCallEnded{CallID: e.ToolCallID, Result: result, Content: []oar.ToolOutputPart{{Type: "text", Text: text}}})
	case agent.EventCompactionStart:
		s.frame("vibevalley/compaction", map[string]any{"phase": "start"}, oar.CompactionStarted{Trigger: e.Reason})
	case agent.EventCompactionEnd:
		outcome := "failed"
		if e.Compaction != nil {
			outcome = "completed"
		}
		s.frame("vibevalley/compaction", map[string]any{"phase": "end"}, oar.CompactionEnded{Outcome: outcome, Trigger: e.Reason})
	case agent.EventAgentSettled:
		switch {
		case e.Aborted:
			s.end(oar.AbortedOutcome())
		case s.failed != "":
			s.end(oar.Failed(oar.FailureUnknown, s.failed))
		default:
			s.end(oar.Completed())
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
		s.agent.Send(agent.UserMessage(input))
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
	s.end(oar.AbortedOutcome())
	s.disposed = true
	s.mu.Unlock()
	s.agent.Stop()
	s.agent.Close()
	s.events.Close()
	s.listening.Wait()
	s.mcp.Close()
	s.cancel()
	code := 0
	s.kernel.Respond(request.ID, oar.ExitedBody(&code), kernel.RecordAt{})
	return nil
}
