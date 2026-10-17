package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

func home(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "vibevalley-agent-")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.RemoveAll(dir) })
	return dir
}

func eq(t *testing.T, got, want any) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got  %#v\nwant %#v", got, want)
	}
}

func match(t *testing.T, pattern, s string) {
	t.Helper()
	if !regexp.MustCompile(pattern).MatchString(s) {
		t.Fatalf("%q does not match %s", s, pattern)
	}
}

func lastUser(c ai.Context) string {
	for i := len(c.Messages) - 1; i >= 0; i-- {
		if m, ok := c.Messages[i].(ai.UserMessage); ok {
			return MessageText(m)
		}
	}
	return ""
}

type toolResult struct {
	failed bool
	text   string
}

func results(c ai.Context) []toolResult {
	var out []toolResult
	for _, m := range c.Messages {
		if r, ok := m.(ai.ToolResultMessage); ok {
			out = append(out, toolResult{r.IsError, MessageText(r)})
		}
	}
	return out
}

func answered(c ai.Context) bool {
	return len(c.Messages) > 0 && c.Messages[len(c.Messages)-1].Role() == "toolResult"
}

type step = ai.FauxResponseFactory

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

func (r *rig) until(f func([]AgentEvent) bool) {
	r.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if f(r.all()) {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	r.t.Fatal("timed out waiting for events")
}

func has(kind string) func([]AgentEvent) bool {
	return func(events []AgentEvent) bool {
		for _, e := range events {
			if e.Type == kind {
				return true
			}
		}
		return false
	}
}

func (r *rig) ask(text string) string {
	r.t.Helper()
	said, err := r.agent.Ask(r.ctx, UserMessage(text))
	if err != nil {
		r.t.Fatal(err)
	}
	return said
}

func withAgent(t *testing.T, dir string, steps []ai.FauxResponseStep, body func(r *rig), extra func(o *AgentOptions), faux ...*ai.FauxProviderHandle) {
	t.Helper()
	f := ai.FauxProvider(ai.FauxProviderOptions{})
	if len(faux) > 0 {
		f = faux[0]
	}
	f.AppendResponses(steps...)
	ctx := ai.WithProviders(context.Background(), f.Provider)
	options := AgentOptions{
		Name: "test", Instructions: "你是测试用的助手。", Model: f.GetModel(), Home: dir, Cwd: dir, NoSkills: true,
		Tools: CodingTools(CodingOptions{Cwd: dir}),
	}
	if extra != nil {
		extra(&options)
	}
	agent := NewAgent(ctx, options)
	defer agent.Close()
	r := &rig{t: t, agent: agent, faux: f, ctx: ctx}
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

func roles(text string) []string {
	var out []string
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		var m struct {
			Role string `json:"role"`
		}
		_ = json.Unmarshal([]byte(line), &m)
		out = append(out, m.Role)
	}
	return out
}

func said(messages []agentcore.AgentMessage) []string {
	var out []string
	for _, m := range messages {
		out = append(out, m.Role()+":"+MessageText(m))
	}
	return out
}

func TestAToolIsRunAndItsResultGoesBack(t *testing.T) {
	dir := home(t)
	_ = os.WriteFile(filepath.Join(dir, "notes.txt"), []byte("第一行\n第二行\n"), 0o644)
	withAgent(t, dir, []ai.FauxResponseStep{
		ai.FauxAssistantMessage([]ai.Content{ai.FauxThinking("先读文件"), ai.FauxToolCall("read_file", `{"path":"notes.txt"}`, "")}),
		step(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
			if rs := results(c); len(rs) > 0 && strings.Contains(rs[0].text, "第二行") {
				return ai.FauxAssistantMessage("读到了：两行")
			}
			return ai.FauxAssistantMessage("读到了：没读到")
		}),
	}, func(r *rig) {
		eq(t, r.ask("看看 notes.txt"), "读到了：两行")
		r.until(has(EventAgentSettled))
		var tools []string
		for _, e := range r.all() {
			if e.Type == agentcore.EventToolExecutionStart || e.Type == agentcore.EventToolExecutionEnd {
				tools = append(tools, e.Type+":"+e.ToolName)
			}
		}
		eq(t, tools, []string{"tool_execution_start:read_file", "tool_execution_end:read_file"})
		flash, _ := ai.GetModel("deepseek", "deepseek-flash")
		found := false
		for _, m := range ai.ToChatMessages(flash, r.faux.State().Contexts[1]) {
			if m.Role == "assistant" && m.ReasoningContent == "先读文件" {
				found = true
			}
		}
		eq(t, found, true)
		events := r.all()
		eq(t, events[len(events)-1].Type, EventAgentSettled)
	}, nil)
	data, _ := os.ReadFile(filepath.Join(dir, "test.jsonl"))
	eq(t, roles(string(data)), []string{"user", "assistant", "toolResult", "assistant"})
}

func TestAToolThatFailsTellsTheModelWhy(t *testing.T) {
	dir := home(t)
	_ = os.WriteFile(filepath.Join(dir, "a.txt"), []byte("x x\n"), 0o644)
	withAgent(t, dir, []ai.FauxResponseStep{
		ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("edit_file", `{"path":"a.txt","old_text":"x","new_text":"y"}`, ""), ai.FauxToolCall("read_file", `{"file":"oops"}`, "")}),
		step(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
			var parts []string
			for _, r := range results(c) {
				parts = append(parts, fmt.Sprintf("%v:%s", r.failed, runeSlice(r.text, 0, 12)))
			}
			return ai.FauxAssistantMessage(strings.Join(parts, "|"))
		}),
	}, func(r *rig) {
		match(t, `^true:old_text 在 a\|true:参数不对`, r.ask("改"))
	}, nil)
}

func TestSendSteersLaterWaits(t *testing.T) {
	dir := home(t)
	nap := TextTool(TextToolSpec[struct{}]{Name: "nap", Description: "睡一会", Parameters: agentcore.ObjectSchema(nil),
		Run: func(ctx context.Context, _ struct{}, _ ToolContext) (string, error) {
			time.Sleep(40 * time.Millisecond)
			return "醒了", nil
		}})
	withAgent(t, dir, []ai.FauxResponseStep{
		ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("nap", nil, "")}),
		step(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
			return ai.FauxAssistantMessage("第二次听到：" + lastUser(c))
		}),
		step(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
			return ai.FauxAssistantMessage("第三次听到：" + lastUser(c))
		}),
	}, func(r *rig) {
		r.agent.Send(UserMessage("开始"))
		time.Sleep(10 * time.Millisecond)
		r.agent.Later(UserMessage("完了再说这个"))
		r.agent.Send(UserMessage("顺便"))
		deadline := time.Now().Add(5 * time.Second)
		for len(r.agent.History()) < 7 && time.Now().Before(deadline) {
			time.Sleep(10 * time.Millisecond)
		}
		eq(t, said(r.agent.History()), []string{
			"user:开始", "assistant:", "toolResult:醒了", "user:顺便", "assistant:第二次听到：顺便", "user:完了再说这个", "assistant:第三次听到：完了再说这个",
		})
	}, func(o *AgentOptions) { o.Tools = []agentcore.AgentTool{nap} })
}

func TestTheStepLimit(t *testing.T) {
	dir := home(t)
	forever := func() ai.FauxResponseStep {
		return ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("list_dir", nil, "")})
	}
	withAgent(t, dir, []ai.FauxResponseStep{forever(), forever(), forever(), forever()}, func(r *rig) {
		r.ask("一直列")
		eq(t, r.faux.State().CallCount, 3)
	}, func(o *AgentOptions) { o.MaxSteps = 3 })
}

func countUsers(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
	n := 0
	for _, m := range c.Messages {
		if m.Role() == "user" {
			n++
		}
	}
	return ai.FauxAssistantMessage(fmt.Sprintf("第 %d 句", n))
}

func TestARestartedAgentContinuesCurrentSessionAndIgnoresLegacy(t *testing.T) {
	dir := home(t)
	withAgent(t, dir, []ai.FauxResponseStep{step(countUsers)}, func(r *rig) { eq(t, r.ask("一"), "第 1 句") }, nil)
	withAgent(t, dir, []ai.FauxResponseStep{step(countUsers)}, func(r *rig) { eq(t, r.ask("二"), "第 2 句") }, nil)

	old := home(t)
	_ = os.WriteFile(filepath.Join(old, "test.json"), []byte(ai.Stringify(map[string]any{
		"content": []any{
			map[string]any{"role": "user", "content": []any{map[string]any{"type": "text", "text": "旧的话"}}},
			map[string]any{"role": "assistant", "content": []any{
				map[string]any{"type": "reasoning", "text": "想"},
				map[string]any{"type": "tool-call", "id": "t1", "name": "list_dir", "params": map[string]any{}},
			}},
			map[string]any{"role": "tool", "content": []any{map[string]any{"type": "tool-result", "id": "t1", "name": "list_dir", "result": "（空的）", "isFailure": false}}},
			map[string]any{"role": "assistant", "content": []any{map[string]any{"type": "text", "text": "旧的回答"}}},
		},
	})), 0o644)
	withAgent(t, old, []ai.FauxResponseStep{step(countUsers)}, func(r *rig) {
		eq(t, len(r.agent.History()), 0)
		eq(t, r.ask("新的话"), "第 1 句")
	}, nil)
	entries, _ := os.ReadDir(old)
	var names []string
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "test") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	eq(t, names, []string{"test.json", "test.jsonl"})
}

func summarizing(c ai.Context) bool { return lastUser(c) == SUMMARY_IN_PLACE }

func TestALongConversationIsFolded(t *testing.T) {
	dir := home(t)
	long := step(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
		if summarizing(c) {
			return ai.FauxAssistantMessage("摘要：说了五件事")
		}
		return ai.FauxAssistantMessage(strings.Repeat("好的。", 150))
	})
	steps := make([]ai.FauxResponseStep, 12)
	for i := range steps {
		steps[i] = long
	}
	options := func(o *AgentOptions) {
		o.ContextTokens = 900
		o.KeepRecent = 2
	}
	withAgent(t, dir, steps, func(r *rig) {
		for n := 1; n <= 5; n++ {
			r.ask(fmt.Sprintf("第 %d 件事", n))
		}
		r.until(func(events []AgentEvent) bool {
			for _, e := range events {
				if e.Type == EventCompactionEnd && e.Compaction != nil {
					return true
				}
			}
			return false
		})
		contexts := r.faux.State().Contexts
		var last ai.Context
		for _, c := range contexts {
			if !summarizing(c) {
				last = c
			}
		}
		first, _ := last.Messages[0].(ai.UserMessage)
		match(t, `^【之前的对话压成了下面的摘要，原文在 .*archive.*】\n<summary>\n摘要：说了五件事`, MessageText(first))
		eq(t, r.agent.History()[0].Role(), "compactionSummary")
	}, options)
	archived, _ := os.ReadDir(filepath.Join(dir, "archive"))
	if len(archived) < 1 {
		t.Fatal("nothing archived")
	}
	withAgent(t, dir, nil, func(r *rig) {
		history := r.agent.History()
		eq(t, history[0].Role(), "compactionSummary")
		if len(history) > 6 {
			t.Fatalf("history of %d", len(history))
		}
	}, options)
}

func TestSkillsAreListedAndRead(t *testing.T) {
	dir := home(t)
	_ = os.MkdirAll(filepath.Join(dir, "skills", "tidy"), 0o755)
	_ = os.WriteFile(filepath.Join(dir, "skills", "tidy", "SKILL.md"), []byte("---\nname: tidy\ndescription: 整理代码时用\n---\n先跑 lint"), 0o644)
	withAgent(t, dir, []ai.FauxResponseStep{
		ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("load_skill", `{"name":"tidy"}`, "")}),
		step(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
			lines := strings.Split(results(c)[0].text, "\n")
			return ai.FauxAssistantMessage(lines[len(lines)-1])
		}),
	}, func(r *rig) {
		eq(t, r.ask("整理一下"), "先跑 lint")
		if !strings.Contains(r.faux.State().Contexts[0].SystemPrompt, "- tidy：整理代码时用") {
			t.Fatal(r.faux.State().Contexts[0].SystemPrompt)
		}
	}, func(o *AgentOptions) {
		o.NoSkills = false
		o.Skills = []string{filepath.Join(dir, "skills")}
	})
}

func TestHelpersWorkSideBySide(t *testing.T) {
	dir := home(t)
	var running, most atomic.Int32
	nap := TextTool(TextToolSpec[struct{}]{Name: "nap", Description: "睡一会", Parameters: agentcore.ObjectSchema(nil),
		Run: func(context.Context, struct{}, ToolContext) (string, error) {
			n := running.Add(1)
			defer running.Add(-1)
			for {
				m := most.Load()
				if n <= m || most.CompareAndSwap(m, n) {
					break
				}
			}
			time.Sleep(30 * time.Millisecond)
			return "醒了", nil
		}})
	helperOrNot := step(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
		if strings.Contains(c.SystemPrompt, "派出去的帮手") {
			if answered(c) {
				return ai.FauxAssistantMessage(MessageText(c.Messages[0].(ai.UserMessage)) + " 做完了")
			}
			return ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("nap", nil, "")})
		}
		if !answered(c) {
			return ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("spawn_agent", `{"task":"查 A"}`, ""), ai.FauxToolCall("spawn_agent", `{"task":"查 B"}`, "")})
		}
		var parts []string
		for _, r := range results(c) {
			parts = append(parts, r.text)
		}
		return ai.FauxAssistantMessage(strings.Join(parts, "；"))
	})
	steps := make([]ai.FauxResponseStep, 6)
	for i := range steps {
		steps[i] = helperOrNot
	}
	withAgent(t, dir, steps, func(r *rig) {
		eq(t, r.ask("同时查 A 和 B"), "查 A 做完了；查 B 做完了")
		eq(t, most.Load(), int32(2))
	}, func(o *AgentOptions) {
		o.Tools = []agentcore.AgentTool{nap}
		o.Schedules = new(false)
	})
}

func TestAScheduleThatComesDueWakesTheAgent(t *testing.T) {
	dir := home(t)
	_ = os.WriteFile(filepath.Join(dir, "schedules.json"), []byte(`[{"id":"job-1","name":"早报","message":"汇总昨天的进展","at":"2026-01-01T00:00:00.000Z","created":"2026-01-01T00:00:00.000Z"}]`), 0o644)
	withAgent(t, dir, []ai.FauxResponseStep{
		step(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
			return ai.FauxAssistantMessage("收到：" + lastUser(c))
		}),
	}, func(r *rig) {
		r.until(has(EventAgentSettled))
		history := r.agent.History()
		eq(t, history[0].Role(), "custom")
		match(t, `^收到：【定时任务「早报」到点了（job-1）】\n汇总昨天的进展$`, MessageText(history[1]))
	}, func(o *AgentOptions) { o.ScheduleTick = 10 * time.Millisecond })
	data, _ := os.ReadFile(filepath.Join(dir, "schedules.json"))
	var jobs []Job
	_ = json.Unmarshal(data, &jobs)
	eq(t, len(jobs), 0)
}

func TestTheSystemPromptStaysTheSameBetweenFolds(t *testing.T) {
	dir := home(t)
	_ = os.WriteFile(MemoryFile(dir), []byte("- 2026-10-01 主人叫阿周\n- 2026-10-02 用中文\n"), 0o644)
	withAgent(t, dir, []ai.FauxResponseStep{ai.FauxAssistantMessage("一"), ai.FauxAssistantMessage("二")}, func(r *rig) {
		eq(t, r.agent.MemoryNews(), "")
		r.ask("a")
		_ = Remember(dir, "主人喜欢短句", time.Date(2026, 10, 18, 9, 0, 0, 0, time.Local))
		_ = ForgetLine(dir, lineID("- 2026-10-02 用中文"))
		news := r.agent.MemoryNews()
		eq(t, news, "【记性有更新】\n+ 2026-10-18 主人喜欢短句\n− 2026-10-02 用中文")
		eq(t, r.agent.MemoryNews(), "")
		r.ask(news + "\n\nb")
		contexts := r.faux.State().Contexts
		eq(t, contexts[1].SystemPrompt, contexts[0].SystemPrompt)
		match(t, `主人叫阿周\n- 2026-10-02 用中文$`, contexts[0].SystemPrompt)
		if strings.Contains(contexts[0].SystemPrompt, "现在：") {
			t.Fatal(contexts[0].SystemPrompt)
		}
		match(t, `^【记性有更新】`, lastUser(contexts[1]))
		eq(t, len(prefixChanges(r)), 0)
	}, nil)
}

func TestAFoldMakesTheSystemPromptAnew(t *testing.T) {
	dir := home(t)
	long := step(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
		if summarizing(c) {
			return ai.FauxAssistantMessage("摘要")
		}
		return ai.FauxAssistantMessage(strings.Repeat("好的。", 150))
	})
	steps := make([]ai.FauxResponseStep, 12)
	for i := range steps {
		steps[i] = long
	}
	withAgent(t, dir, steps, func(r *rig) {
		r.ask("第 1 件事")
		_ = Remember(dir, "记在折叠之前", time.Now())
		folded := func(events []AgentEvent) bool {
			return slices.ContainsFunc(events, func(e AgentEvent) bool { return e.Type == EventCompactionEnd && e.Compaction != nil })
		}
		for n := 2; n <= 5 && !folded(r.all()); n++ {
			r.ask(fmt.Sprintf("第 %d 件事", n))
		}
		r.until(folded)
		r.ask("折叠之后")
		var prompts []string
		for _, c := range r.faux.State().Contexts {
			if !summarizing(c) {
				prompts = append(prompts, c.SystemPrompt)
			}
		}
		if strings.Contains(prompts[0], "记在折叠之前") || !strings.Contains(prompts[len(prompts)-1], "记在折叠之前") {
			t.Fatalf("prompts %q", prompts)
		}
		eq(t, len(prefixChanges(r)), 0)
	}, func(o *AgentOptions) {
		o.ContextTokens = 900
		o.KeepRecent = 2
	})
}

func settledEvent(r *rig) AgentEvent {
	for _, e := range r.all() {
		if e.Type == EventAgentSettled {
			return e
		}
	}
	return AgentEvent{}
}

func TestStopEndsTheRunUnderWay(t *testing.T) {
	dir := home(t)
	faux := ai.FauxProvider(ai.FauxProviderOptions{Delay: 15 * time.Millisecond})
	withAgent(t, dir, []ai.FauxResponseStep{ai.FauxAssistantMessage([]ai.Content{ai.FauxText("这是一段很长很长很长很长很长的回答")})}, func(r *rig) {
		r.agent.Send(UserMessage("说"))
		r.until(func(events []AgentEvent) bool {
			for _, e := range events {
				if e.Type == agentcore.EventMessageUpdate && e.AssistantMessageEvent.Type == ai.EventTextDelta {
					return true
				}
			}
			return false
		})
		r.agent.Stop()
		r.until(has(EventAgentSettled))
		eq(t, settledEvent(r).Aborted, true)
		history := r.agent.History()
		last, ok := history[len(history)-1].(ai.AssistantMessage)
		eq(t, ok, true)
		eq(t, last.StopReason, ai.StopAborted)
	}, nil, faux)
}

func TestStoppedWhileAToolRuns(t *testing.T) {
	dir := home(t)
	withAgent(t, dir, []ai.FauxResponseStep{ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("bash", `{"command":"sleep 5"}`, "")})}, func(r *rig) {
		r.agent.Send(UserMessage("睡"))
		r.until(has(agentcore.EventToolExecutionStart))
		r.agent.Stop()
		r.until(has(EventAgentSettled))
		eq(t, settledEvent(r).Aborted, true)
		history := r.agent.History()
		eq(t, history[len(history)-1].Role(), "toolResult")
	}, nil)
}

func TestATSSessionFileReadsBack(t *testing.T) {
	dir := home(t)
	lines := []string{
		`{"role":"user","content":"一","timestamp":1}`,
		`{"role":"assistant","content":[{"type":"text","text":"好"}],"api":"openai-completions","provider":"deepseek","model":"deepseek-flash","usage":{"input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2,"cost":{"input":0,"output":0,"cacheRead":0,"cacheWrite":0,"total":0}},"stopReason":"stop","timestamp":2,"durationMs":5}`,
		`{"role":"custom","customType":"farmNews","content":"老周做完了","display":false,"timestamp":3}`,
		`{"role":"compactionSummary","summary":"摘要","tokensBefore":900,"timestamp":4,"archive":"/x/archive/manager.md","kept":2}`,
		`{"role":"user","content":"二","timestamp":5}`,
	}
	_ = os.WriteFile(filepath.Join(dir, "manager.jsonl"), []byte(strings.Join(lines, "\n")+"\n{\"role\":\"us"), 0o644)
	history := SessionAt(filepath.Join(dir, "manager.jsonl")).Load()
	eq(t, said(history), []string{"compactionSummary:摘要", "assistant:好", "custom:老周做完了", "user:二"})
	for i, m := range parseLines(strings.Join(lines, "\n")) {
		eq(t, ai.Stringify(m), lines[i])
	}
}

func prefixChanges(r *rig) []string {
	var out []string
	for _, e := range r.all() {
		if e.Type == EventPrefixChanged {
			out = append(out, e.Reason)
		}
	}
	return out
}

func TestAChangedToolIsToldAsAChangedPrefix(t *testing.T) {
	dir := home(t)
	withAgent(t, dir, []ai.FauxResponseStep{ai.FauxAssistantMessage("一"), ai.FauxAssistantMessage("二")}, func(r *rig) {
		r.ask("a")
		r.until(has(EventAgentSettled))
		eq(t, len(prefixChanges(r)), 0)
		r.agent.Core.SetTools(r.agent.Core.State().Tools[1:])
		r.ask("b")
		r.until(func(events []AgentEvent) bool { return len(prefixChanges(r)) > 0 })
		if got := prefixChanges(r); !strings.Contains(got[0], "tools") {
			t.Fatalf("changed %q", got)
		}
	}, nil)
}

func idleRig(t *testing.T, wakeSoon func(time.Duration) bool, summary ai.FauxResponseFactory, body func(r *rig, choices *sync.Map)) {
	dir := home(t)
	var choices sync.Map
	answer := step(func(c ai.Context, o ai.StreamOptions, s ai.FauxProviderState, m ai.Model) ai.AssistantMessage {
		if summarizing(c) {
			choices.Store(s.CallCount, o.ToolChoice)
			return summary(c, o, s, m)
		}
		if strings.HasPrefix(c.SystemPrompt, SUMMARY_INSTRUCTIONS) {
			return ai.FauxAssistantMessage("另起的摘要")
		}
		return ai.FauxAssistantMessage(strings.Repeat("好的。", 150))
	})
	steps := make([]ai.FauxResponseStep, 8)
	for i := range steps {
		steps[i] = answer
	}
	withAgent(t, dir, steps, func(r *rig) { body(r, &choices) }, func(o *AgentOptions) {
		o.KeepRecent = 2
		o.IdleFoldAt = 300
		o.IdleFoldAfter = 50 * time.Millisecond
		o.WakeSoon = wakeSoon
	})
}

func idleFolded(events []AgentEvent) bool {
	return slices.ContainsFunc(events, func(e AgentEvent) bool {
		return e.Type == EventCompactionEnd && e.Reason == "idle" && e.Compaction != nil
	})
}

func TestAnIdleConversationIsFoldedWithTheSameStart(t *testing.T) {
	idleRig(t, nil, func(ai.Context, ai.StreamOptions, ai.FauxProviderState, ai.Model) ai.AssistantMessage {
		return ai.FauxAssistantMessage("就地的摘要")
	}, func(r *rig, choices *sync.Map) {
		for _, words := range []string{"一", "二", "三"} {
			r.ask(words)
		}
		eq(t, r.faux.State().CallCount, 3)
		r.until(idleFolded)
		contexts := r.faux.State().Contexts
		eq(t, len(contexts), 4)
		before, folding := contexts[2], contexts[3]
		eq(t, folding.SystemPrompt, before.SystemPrompt)
		eq(t, ai.Stringify(folding.Tools), ai.Stringify(before.Tools))
		eq(t, ai.Stringify(folding.Messages[:len(before.Messages)]), ai.Stringify(before.Messages))
		eq(t, len(folding.Messages), len(before.Messages)+2)
		choice, _ := choices.Load(4)
		eq(t, choice, "none")
		history := r.agent.History()
		eq(t, history[0].(CompactionSummaryMessage).Summary, "就地的摘要")
		eq(t, said(history[1:]), []string{"user:三", "assistant:" + strings.Repeat("好的。", 150)})
	})
}

func TestAToolCalledInsteadOfASummaryIsAskedAgainOnItsOwn(t *testing.T) {
	idleRig(t, nil, func(ai.Context, ai.StreamOptions, ai.FauxProviderState, ai.Model) ai.AssistantMessage {
		return ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("list_dir", nil, "")})
	}, func(r *rig, _ *sync.Map) {
		for _, words := range []string{"一", "二", "三"} {
			r.ask(words)
		}
		r.until(idleFolded)
		eq(t, r.agent.History()[0].(CompactionSummaryMessage).Summary, "另起的摘要")
	})
}

func TestNoIdleFoldWhenItWillBeWokenSoon(t *testing.T) {
	var asked atomic.Int32
	idleRig(t, func(within time.Duration) bool {
		eq(t, within, 50*time.Millisecond)
		asked.Add(1)
		return true
	}, func(ai.Context, ai.StreamOptions, ai.FauxProviderState, ai.Model) ai.AssistantMessage {
		return ai.FauxAssistantMessage("摘要")
	}, func(r *rig, _ *sync.Map) {
		for _, words := range []string{"一", "二", "三"} {
			r.ask(words)
		}
		deadline := time.Now().Add(5 * time.Second)
		for asked.Load() == 0 && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		time.Sleep(50 * time.Millisecond)
		eq(t, asked.Load(), int32(1))
		eq(t, r.faux.State().CallCount, 3)
		eq(t, r.agent.History()[0].Role(), "user")
	})
}

func TestCutPointKeepsTheLastWords(t *testing.T) {
	u := func(text string) agentcore.AgentMessage { return UserMessage(text) }
	a := func(text string) agentcore.AgentMessage { return ai.FauxAssistantMessage(text) }
	call := ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("x", nil, "")})
	result := ai.ToolResultMessage{ToolName: "x"}
	tools := []agentcore.AgentMessage{u("1"), a("一"), u("2"), a("二"), u("3"), call, result, call, result, call, result, a("三"), u("4"), call, result, a("四")}
	for _, c := range []struct {
		name                 string
		messages             []agentcore.AgentMessage
		keepRecent, keepSaid int
		want                 int
	}{
		{"recent only", tools, 3, 0, 12},
		{"back to three words", tools, 3, 3, 2},
		{"back to two", tools, 3, 2, 4},
		{"one is there already", tools, 3, 1, 12},
		{"not enough words: nowhere", tools, 3, 5, 0},
		{"nothing", nil, 2, 3, 0},
	} {
		if got := CutPoint(c.messages, c.keepRecent, c.keepSaid); got != c.want {
			t.Fatalf("%s: cut at %d, want %d", c.name, got, c.want)
		}
	}
}
