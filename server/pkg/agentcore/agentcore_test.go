package agentcore

// The orders of events are the ones pi-agent-core's README gives.

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"vibevalley/pkg/ai"
)

type note struct {
	Text      string
	Timestamp int64
}

func (note) Role() string           { return "note" }
func (n note) Time() int64          { return n.Timestamp }
func user(text string) AgentMessage { return UserMessageOf(text) }

var probe struct {
	running atomic.Int32
	most    atomic.Int32
}

func sleepy(name string, d time.Duration, out string, mode ToolExecutionMode) AgentTool {
	if out == "" {
		out = name + " 好了"
	}
	return DefineTool(ToolSpec[struct{}]{
		Name: name, Description: name, Parameters: ObjectSchema(nil), ExecutionMode: mode,
		Execute: func(ctx context.Context, _ string, _ struct{}, _ AgentToolUpdateCallback) (AgentToolResult, error) {
			n := probe.running.Add(1)
			defer probe.running.Add(-1)
			for {
				most := probe.most.Load()
				if n <= most || probe.most.CompareAndSwap(most, n) {
					break
				}
			}
			select {
			case <-time.After(d):
			case <-ctx.Done():
				return AgentToolResult{}, ctx.Err()
			}
			return TextResult(out), nil
		},
	})
}

var echo = DefineTool(ToolSpec[struct {
	Text string `json:"text"`
}]{
	Name: "echo", Label: "回声", Description: "把 text 原样说回来",
	Parameters: ObjectSchema(map[string]any{"text": StringSchema()}, "text"),
	Execute: func(_ context.Context, _ string, p struct {
		Text string `json:"text"`
	}, onUpdate AgentToolUpdateCallback) (AgentToolResult, error) {
		onUpdate(TextResult("…"))
		return TextResult("回声：" + p.Text), nil
	},
})

type rig struct {
	t      *testing.T
	agent  *Agent
	faux   *ai.FauxProviderHandle
	ctx    context.Context
	mu     sync.Mutex
	events []AgentEvent
}

func (r *rig) all() []AgentEvent {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]AgentEvent(nil), r.events...)
}

func (r *rig) settled() []AgentEvent {
	r.t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	last := -1
	for time.Now().Before(deadline) {
		events := r.all()
		if len(events) > 0 && events[len(events)-1].Type == EventAgentEnd && len(events) == last {
			return events
		}
		last = len(events)
		time.Sleep(10 * time.Millisecond)
	}
	r.t.Fatal("the run did not settle")
	return nil
}

func (r *rig) until(f func([]AgentEvent) bool) {
	r.t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if f(r.all()) {
			return
		}
		time.Sleep(2 * time.Millisecond)
	}
	r.t.Fatal("timed out waiting for events")
}

type rigOptions struct {
	options AgentOptions
	delay   time.Duration
	tools   []AgentTool
}

func withAgent(t *testing.T, o rigOptions, script func(*ai.FauxProviderHandle), body func(r *rig)) {
	t.Helper()
	faux := ai.FauxProvider(ai.FauxProviderOptions{Delay: o.delay})
	script(faux)
	ctx := ai.WithProviders(context.Background(), faux.Provider)
	options := o.options
	options.InitialState.SystemPrompt = "你是测试"
	options.InitialState.Tools = []AgentTool{echo}
	if o.tools != nil {
		options.InitialState.Tools = o.tools
	}
	if options.InitialState.Model.ID == "" {
		options.InitialState.Model = faux.GetModel()
	}
	agent := NewAgent(ctx, options)
	defer agent.Close()
	r := &rig{t: t, agent: agent, faux: faux, ctx: ctx}
	sub := agent.Subscribe()
	defer sub.Close()
	go func() {
		for e := range sub.C {
			r.mu.Lock()
			r.events = append(r.events, e)
			r.mu.Unlock()
		}
	}()
	body(r)
}

func kinds(events []AgentEvent) []string {
	out := []string{}
	for _, e := range events {
		switch {
		case strings.HasPrefix(e.Type, "message_"):
			out = append(out, e.Type+":"+e.Message.Role())
		case strings.HasPrefix(e.Type, "tool_execution"):
			out = append(out, e.Type+":"+e.ToolName)
		default:
			out = append(out, e.Type)
		}
	}
	return out
}

func squeeze(list []string) []string {
	out := []string{}
	for i, k := range list {
		if k == "message_update:assistant" && i > 0 && list[i-1] == k {
			continue
		}
		out = append(out, k)
	}
	return out
}

func eq(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %#v\nwant %#v", got, want)
	}
}

func text(m AgentMessage) string {
	switch m := m.(type) {
	case note:
		return m.Text
	case ai.UserMessage:
		return m.Content.Words("")
	case ai.SystemMessage:
		return m.Content.Words("")
	case ai.AssistantMessage:
		return ai.ContentText(m.Content, "")
	case ai.ToolResultMessage:
		return ai.ContentText(m.Content, "")
	}
	return ""
}

func roles(messages []AgentMessage) []string {
	out := []string{}
	for _, m := range messages {
		out = append(out, m.Role())
	}
	return out
}

func lastUser(c ai.Context) string {
	for i := len(c.Messages) - 1; i >= 0; i-- {
		if m, ok := c.Messages[i].(ai.UserMessage); ok {
			return m.Content.Words("")
		}
	}
	return ""
}

type factory = ai.FauxResponseFactory

func TestAPlainAnswer(t *testing.T) {
	withAgent(t, rigOptions{}, func(f *ai.FauxProviderHandle) { f.SetResponses(ai.FauxAssistantMessage("你好")) }, func(r *rig) {
		if err := r.agent.PromptText(r.ctx, "hi"); err != nil {
			t.Fatal(err)
		}
		eq(t, squeeze(kinds(r.settled())), []string{
			"agent_start", "turn_start", "message_start:user", "message_end:user", "message_start:assistant",
			"message_update:assistant", "message_end:assistant", "turn_end", "agent_end",
		})
		s := r.agent.State()
		eq(t, roles(s.Messages), []string{"user", "assistant"})
		eq(t, s.IsStreaming, false)
		eq(t, s.StreamingMessage, nil)
	})
}

func TestToolsOverTwoTurns(t *testing.T) {
	withAgent(t, rigOptions{}, func(f *ai.FauxProviderHandle) {
		f.SetResponses(ai.FauxAssistantMessage([]ai.Content{ai.FauxText("我说一下"), ai.FauxToolCall("echo", `{"text":"哈"}`, "c1")}), ai.FauxAssistantMessage("说完了"))
	}, func(r *rig) {
		_ = r.agent.PromptText(r.ctx, "说个哈")
		events := r.settled()
		eq(t, squeeze(kinds(events)), []string{
			"agent_start", "turn_start", "message_start:user", "message_end:user", "message_start:assistant", "message_update:assistant",
			"message_end:assistant", "tool_execution_start:echo", "tool_execution_update:echo", "tool_execution_end:echo",
			"message_start:toolResult", "message_end:toolResult", "turn_end", "turn_start", "message_start:assistant",
			"message_update:assistant", "message_end:assistant", "turn_end", "agent_end",
		})
		for _, e := range events {
			if e.Type == EventTurnEnd {
				eq(t, len(e.ToolResults), 1)
				eq(t, ai.ContentText(e.ToolResults[0].Content, ""), "回声：哈")
				break
			}
		}
		state := r.faux.State()
		eq(t, ai.Stringify(state.Contexts[0].Tools[0].Parameters), `{"additionalProperties":true,"properties":{"text":{"type":"string"}},"required":["text"],"type":"object"}`)
		eq(t, state.Contexts[0].Tools[0].Description, "把 text 原样说回来")
		second := state.Contexts[1].Messages
		eq(t, second[len(second)-1].Role(), "toolResult")
		eq(t, state.Contexts[0].SystemPrompt, "你是测试")
		end := events[len(events)-1]
		eq(t, roles(end.Messages), []string{"user", "assistant", "toolResult", "assistant"})
	})
}

func TestSteeringJoinsBeforeTheNextRequestAFollowUpWaits(t *testing.T) {
	withAgent(t, rigOptions{}, func(f *ai.FauxProviderHandle) {
		f.SetResponses(
			factory(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
				return ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("echo", ai.Stringify(map[string]string{"text": fmt.Sprintf("第一次看到 %d 句", len(c.Messages))}), "")})
			}),
			factory(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
				return ai.FauxAssistantMessage("第二次，最后一句：" + lastUser(c))
			}),
			factory(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
				return ai.FauxAssistantMessage("第三次，最后一句：" + lastUser(c))
			}),
		)
	}, func(r *rig) {
		r.agent.FollowUp(user("然后呢"))
		r.agent.Steer(user("顺便"))
		_ = r.agent.PromptText(r.ctx, "开始")
		var said []string
		for _, m := range r.agent.State().Messages {
			said = append(said, m.Role()+":"+text(m))
		}
		eq(t, said, []string{
			"user:开始", "assistant:", "toolResult:回声：第一次看到 1 句", "user:顺便", "assistant:第二次，最后一句：顺便", "user:然后呢", "assistant:第三次，最后一句：然后呢",
		})
		events := r.settled()
		count := func(kind string) int {
			n := 0
			for _, e := range events {
				if e.Type == kind {
					n++
				}
			}
			return n
		}
		eq(t, count(EventAgentStart), 1)
		eq(t, count(EventTurnStart), 3)
	})
}

func TestQueueModes(t *testing.T) {
	for _, mode := range []QueueMode{OneAtATime, QueueAll} {
		withAgent(t, rigOptions{options: AgentOptions{FollowUpMode: mode}}, func(f *ai.FauxProviderHandle) {
			f.SetResponses(ai.FauxAssistantMessage("一"), ai.FauxAssistantMessage("二"), ai.FauxAssistantMessage("三"))
		}, func(r *rig) {
			r.agent.FollowUp(user("a"))
			r.agent.FollowUp(user("b"))
			_ = r.agent.PromptText(r.ctx, "go")
			want := 3
			if mode == QueueAll {
				want = 2
			}
			eq(t, r.faux.State().CallCount, want)
		})
	}
}

func TestBeforeToolCallBlocksAfterToolCallRewrites(t *testing.T) {
	options := AgentOptions{AgentLoopConfig: AgentLoopConfig{
		BeforeToolCall: func(_ context.Context, c BeforeToolCallContext) *BeforeToolCallResult {
			var args struct{ Text string }
			_ = json.Unmarshal(c.ToolCall.Args(), &args)
			if args.Text == "危险" {
				return &BeforeToolCallResult{Block: true, Reason: "这个不行"}
			}
			return nil
		},
		AfterToolCall: func(_ context.Context, c AfterToolCallContext) *AfterToolCallResult {
			return &AfterToolCallResult{Content: []ai.Content{ai.NewText(c.Result.Content[0].Text + "（审过）")}}
		},
	}}
	withAgent(t, rigOptions{options: options}, func(f *ai.FauxProviderHandle) {
		f.SetResponses(ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("echo", `{"text":"危险"}`, "a"), ai.FauxToolCall("echo", `{"text":"平安"}`, "b")}), ai.FauxAssistantMessage("好"))
	}, func(r *rig) {
		_ = r.agent.PromptText(r.ctx, "试试")
		var got []string
		for _, m := range r.agent.State().Messages {
			if res, ok := m.(ai.ToolResultMessage); ok {
				got = append(got, fmt.Sprintf("%s|%v", text(m), res.IsError))
			}
		}
		eq(t, got, []string{"这个不行|true", "回声：平安（审过）|false"})
	})
}

func TestTerminateOnlyWhenEveryResultSaysSo(t *testing.T) {
	stopper := func(name string, terminate bool) AgentTool {
		return DefineTool(ToolSpec[struct{}]{Name: name, Description: name, Parameters: ObjectSchema(nil),
			Execute: func(context.Context, string, struct{}, AgentToolUpdateCallback) (AgentToolResult, error) {
				return TextResult(name, TextResultOptions{Terminate: terminate}), nil
			}})
	}
	for _, c := range []struct {
		both  bool
		calls int
	}{{true, 1}, {false, 2}} {
		withAgent(t, rigOptions{tools: []AgentTool{stopper("a", true), stopper("b", c.both)}}, func(f *ai.FauxProviderHandle) {
			f.SetResponses(ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("a", nil, ""), ai.FauxToolCall("b", nil, "")}), ai.FauxAssistantMessage("又问了"))
		}, func(r *rig) {
			_ = r.agent.PromptText(r.ctx, "go")
			eq(t, r.faux.State().CallCount, c.calls)
		})
	}
}

func TestFinishTurn(t *testing.T) {
	end := AgentOptions{AgentLoopConfig: AgentLoopConfig{FinishTurn: func(context.Context, AgentTurnContext) *AgentTurnDecision { return TurnEnd }}}
	withAgent(t, rigOptions{options: end}, func(f *ai.FauxProviderHandle) {
		f.SetResponses(ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("echo", `{"text":"x"}`, "")}), ai.FauxAssistantMessage("不该有"))
	}, func(r *rig) {
		r.agent.FollowUp(user("也不该进来"))
		_ = r.agent.PromptText(r.ctx, "go")
		eq(t, r.faux.State().CallCount, 1)
		n := 0
		for _, e := range r.settled() {
			if e.Type == EventTurnEnd {
				n++
			}
		}
		eq(t, n, 1)
		eq(t, r.agent.HasQueuedMessages(), true)
	})
	asked := 0
	more := AgentOptions{AgentLoopConfig: AgentLoopConfig{FinishTurn: func(context.Context, AgentTurnContext) *AgentTurnDecision {
		asked++
		if asked == 1 {
			return TurnContinue
		}
		return nil
	}}}
	withAgent(t, rigOptions{options: more}, func(f *ai.FauxProviderHandle) {
		f.SetResponses(ai.FauxAssistantMessage("一"), ai.FauxAssistantMessage("二"))
	}, func(r *rig) {
		_ = r.agent.PromptText(r.ctx, "go")
		eq(t, r.faux.State().CallCount, 2)
		eq(t, roles(r.agent.State().Messages), []string{"user", "assistant", "assistant"})
	})
}

func TestParallelAndSequentialTools(t *testing.T) {
	for _, mode := range []ToolExecutionMode{ToolParallel, ToolSequential} {
		probe.most.Store(0)
		withAgent(t, rigOptions{options: AgentOptions{AgentLoopConfig: AgentLoopConfig{ToolExecution: mode}}, tools: []AgentTool{sleepy("slow", 60*time.Millisecond, "", ""), sleepy("fast", 5*time.Millisecond, "", "")}},
			func(f *ai.FauxProviderHandle) {
				f.SetResponses(ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("slow", nil, ""), ai.FauxToolCall("fast", nil, "")}), ai.FauxAssistantMessage("好"))
			}, func(r *rig) {
				_ = r.agent.PromptText(r.ctx, "go")
				var ends []string
				for _, e := range r.settled() {
					if e.Type == EventToolExecutionEnd {
						ends = append(ends, e.ToolName)
					}
				}
				if mode == ToolParallel {
					eq(t, ends, []string{"fast", "slow"})
				} else {
					eq(t, ends, []string{"slow", "fast"})
				}
				var results []string
				for _, m := range r.agent.State().Messages {
					if m.Role() == "toolResult" {
						results = append(results, text(m))
					}
				}
				eq(t, results, []string{"slow 好了", "fast 好了"})
				want := int32(2)
				if mode == ToolSequential {
					want = 1
				}
				eq(t, probe.most.Load(), want)
			})
	}
	probe.most.Store(0)
	withAgent(t, rigOptions{tools: []AgentTool{sleepy("slow", 30*time.Millisecond, "", ToolSequential), sleepy("fast", 5*time.Millisecond, "", "")}},
		func(f *ai.FauxProviderHandle) {
			f.SetResponses(ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("slow", nil, ""), ai.FauxToolCall("fast", nil, "")}), ai.FauxAssistantMessage("好"))
		}, func(r *rig) {
			_ = r.agent.PromptText(r.ctx, "go")
			eq(t, probe.most.Load(), int32(1))
		})
}

func TestAbortWhileAnswering(t *testing.T) {
	long := "这是一段很长很长很长很长的回答"
	withAgent(t, rigOptions{delay: 15 * time.Millisecond}, func(f *ai.FauxProviderHandle) { f.SetResponses(ai.FauxAssistantMessage(long)) }, func(r *rig) {
		done := make(chan error, 1)
		go func() { done <- r.agent.PromptText(r.ctx, "说") }()
		r.until(func(events []AgentEvent) bool {
			for _, e := range events {
				if e.Type == EventMessageUpdate && e.AssistantMessageEvent.Type == ai.EventTextDelta {
					return true
				}
			}
			return false
		})
		r.agent.Abort()
		<-done
		s := r.agent.State()
		last, ok := s.Messages[len(s.Messages)-1].(ai.AssistantMessage)
		if !ok {
			t.Fatal("the last message is not the answer")
		}
		eq(t, last.StopReason, ai.StopAborted)
		if n := len([]rune(text(last))); n == 0 || n >= len([]rune(long)) {
			t.Fatalf("said %q", text(last))
		}
		eq(t, s.IsStreaming, false)
		eq(t, s.ErrorMessage, "已停下")
		k := kinds(r.settled())
		eq(t, k[len(k)-3:], []string{"message_end:assistant", "turn_end", "agent_end"})
	})
}

func TestAbortWhileAToolRuns(t *testing.T) {
	withAgent(t, rigOptions{tools: []AgentTool{sleepy("slow", 5*time.Second, "", ""), sleepy("fast", time.Millisecond, "", "")}}, func(f *ai.FauxProviderHandle) {
		f.SetResponses(ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("slow", nil, "s"), ai.FauxToolCall("fast", nil, "f")}))
	}, func(r *rig) {
		done := make(chan error, 1)
		go func() { done <- r.agent.PromptText(r.ctx, "go") }()
		r.until(func(events []AgentEvent) bool {
			for _, e := range events {
				if e.Type == EventToolExecutionEnd {
					return true
				}
			}
			return false
		})
		r.agent.Abort()
		<-done
		s := r.agent.State()
		var got []string
		for _, m := range s.Messages {
			if res, ok := m.(ai.ToolResultMessage); ok {
				got = append(got, res.ToolCallID+"|"+text(m))
			}
		}
		eq(t, got, []string{"s|已停下", "f|fast 好了"})
		eq(t, len(s.PendingToolCalls), 0)
		k := kinds(r.settled())
		eq(t, k[len(k)-2:], []string{"turn_end", "agent_end"})
	})
}

func TestToolsThatFailAndAnAnswerThatFails(t *testing.T) {
	broken := DefineTool(ToolSpec[struct{}]{Name: "broken", Parameters: ObjectSchema(nil),
		Execute: func(context.Context, string, struct{}, AgentToolUpdateCallback) (AgentToolResult, error) {
			panic(errors.New("炸了"))
		}})
	refusing := DefineTool(ToolSpec[struct{}]{Name: "refusing", Parameters: ObjectSchema(nil),
		Execute: func(context.Context, string, struct{}, AgentToolUpdateCallback) (AgentToolResult, error) {
			return AgentToolResult{}, errors.New("不干")
		}})
	withAgent(t, rigOptions{tools: []AgentTool{echo, broken, refusing}}, func(f *ai.FauxProviderHandle) {
		f.SetResponses(
			ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("nope", nil, ""), ai.FauxToolCall("echo", `{"wrong":1}`, ""), ai.FauxToolCall("broken", nil, ""), ai.FauxToolCall("refusing", nil, "")}),
			ai.FauxAssistantMessage("服务商挂了", ai.FauxOptions{StopReason: ai.StopError, ErrorMessage: "503"}),
		)
	}, func(r *rig) {
		r.agent.FollowUp(user("不该进来"))
		_ = r.agent.PromptText(r.ctx, "go")
		s := r.agent.State()
		var results []string
		for _, m := range s.Messages {
			if m.Role() == "toolResult" {
				results = append(results, text(m))
			}
		}
		if !regexp.MustCompile(`没有叫 nope 的工具。有：echo、broken、refusing`).MatchString(results[0]) {
			t.Fatal(results[0])
		}
		if !strings.HasPrefix(results[1], "参数不对") {
			t.Fatal(results[1])
		}
		eq(t, results[2], "工具出错：炸了")
		eq(t, results[3], "不干")
		eq(t, s.ErrorMessage, "503")
		eq(t, r.faux.State().CallCount, 2)
	})
}

func TestTheApplicationsOwnMessages(t *testing.T) {
	options := AgentOptions{AgentLoopConfig: AgentLoopConfig{
		ConvertToLlm: func(_ context.Context, messages []AgentMessage) []ai.Message {
			out := []ai.Message{}
			for _, m := range messages {
				switch m := m.(type) {
				case note:
					out = append(out, ai.UserMessage{Content: ai.StringContent("【备注】" + m.Text), Timestamp: m.Timestamp})
				case ai.Message:
					out = append(out, m)
				}
			}
			return out
		},
		TransformContext: func(_ context.Context, messages []AgentMessage) []AgentMessage {
			return append(append([]AgentMessage{}, messages...), ai.UserMessage{Content: ai.StringContent("【现状】一切正常")})
		},
	}}
	withAgent(t, rigOptions{options: options}, func(f *ai.FauxProviderHandle) { f.SetResponses(ai.FauxAssistantMessage("收到")) }, func(r *rig) {
		_ = r.agent.Prompt(r.ctx, note{Text: "主人在开会", Timestamp: 1}, user("看看"))
		var seen []string
		for _, m := range r.faux.State().Contexts[0].Messages {
			seen = append(seen, text(m))
		}
		eq(t, seen, []string{"【备注】主人在开会", "看看", "【现状】一切正常"})
		eq(t, roles(r.agent.State().Messages), []string{"note", "user", "assistant"})
		found := false
		for _, e := range r.settled() {
			if e.Type == EventMessageEnd && e.Message.Role() == "note" {
				found = true
			}
		}
		eq(t, found, true)
	})
}

func TestPrepareRequestChangesTheThinking(t *testing.T) {
	var mu sync.Mutex
	var levels []string
	options := AgentOptions{AgentLoopConfig: AgentLoopConfig{PrepareRequest: func(_ context.Context, p PrepareRequestContext) *AgentRequestUpdate {
		if len(p.Context.Messages) > 2 {
			return &AgentRequestUpdate{ThinkingLevel: "high"}
		}
		return nil
	}}}
	record := func(o ai.StreamOptions) {
		mu.Lock()
		defer mu.Unlock()
		levels = append(levels, o.Reasoning)
	}
	withAgent(t, rigOptions{options: options}, func(f *ai.FauxProviderHandle) {
		f.SetResponses(
			factory(func(_ ai.Context, o ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
				record(o)
				return ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("echo", `{"text":"x"}`, "")})
			}),
			factory(func(_ ai.Context, o ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
				record(o)
				return ai.FauxAssistantMessage("好")
			}),
		)
	}, func(r *rig) {
		_ = r.agent.PromptText(r.ctx, "go")
		eq(t, levels, []string{"", "high"})
	})
}

func TestPromptWhileRunningIsRefusedContinue(t *testing.T) {
	withAgent(t, rigOptions{delay: 10 * time.Millisecond}, func(f *ai.FauxProviderHandle) {
		f.SetResponses(ai.FauxAssistantMessage("慢慢说"), ai.FauxAssistantMessage("接着"), ai.FauxAssistantMessage("排着的"))
	}, func(r *rig) {
		reason := func(err error) string {
			var e *AgentError
			if errors.As(err, &e) {
				return e.Reason
			}
			return fmt.Sprint(err)
		}
		eq(t, reason(r.agent.Continue(r.ctx)), "empty")
		done := make(chan error, 1)
		go func() { done <- r.agent.PromptText(r.ctx, "一") }()
		time.Sleep(20 * time.Millisecond)
		eq(t, reason(r.agent.PromptText(r.ctx, "二")), "busy")
		<-done
		eq(t, reason(r.agent.Continue(r.ctx)), "nothing-to-continue")
		r.agent.SetMessages(append(r.agent.State().Messages, user("还在吗")))
		if err := r.agent.Continue(r.ctx); err != nil {
			t.Fatal(err)
		}
		messages := r.agent.State().Messages
		eq(t, text(messages[len(messages)-1]), "接着")
		r.agent.FollowUp(user("排着"))
		if err := r.agent.Continue(r.ctx); err != nil {
			t.Fatal(err)
		}
		messages = r.agent.State().Messages
		eq(t, []string{text(messages[len(messages)-2]), text(messages[len(messages)-1])}, []string{"排着", "排着的"})
		r.agent.Reset()
		eq(t, len(r.agent.State().Messages), 0)
	})
}

func TestGetApiKeyIsAskedBeforeEveryRequest(t *testing.T) {
	var mu sync.Mutex
	var keys []string
	key := "sk-first"
	options := AgentOptions{AgentLoopConfig: AgentLoopConfig{
		StreamOptions: ai.StreamOptions{APIKey: "sk-fixed"},
		GetApiKey: func(context.Context, string) string {
			mu.Lock()
			defer mu.Unlock()
			return key
		},
		StreamFn: func(ctx context.Context, model ai.Model, c ai.Context, o ai.StreamOptions) <-chan ai.AssistantMessageEvent {
			mu.Lock()
			keys = append(keys, o.APIKey)
			mu.Unlock()
			return ai.Stream(ctx, model, c, o)
		},
	}}
	withAgent(t, rigOptions{options: options}, func(f *ai.FauxProviderHandle) {
		f.SetResponses(ai.FauxAssistantMessage("一"), ai.FauxAssistantMessage("二"))
	}, func(r *rig) {
		_ = r.agent.PromptText(r.ctx, "hi")
		mu.Lock()
		key = "sk-second"
		mu.Unlock()
		_ = r.agent.PromptText(r.ctx, "again")
		eq(t, keys, []string{"sk-first", "sk-second"})
	})
}

func TestAgentLoopAsAStream(t *testing.T) {
	faux := ai.FauxProvider(ai.FauxProviderOptions{})
	faux.SetResponses(ai.FauxAssistantMessage("好"))
	ctx := ai.WithProviders(context.Background(), faux.Provider)
	var got []AgentEvent
	for e := range AgentLoop(ctx, []AgentMessage{user("hi")}, AgentContext{}, AgentLoopConfig{Model: faux.GetModel()}) {
		got = append(got, e)
	}
	k := squeeze(kinds(got))
	eq(t, k[0], "agent_start")
	eq(t, k[len(k)-1], "agent_end")
}
