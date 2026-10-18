package brain

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/internal/task/engine"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

func TestTheAgentTasksAndMarksItsOwnTasks(t *testing.T) {
	tools := TaskTools(&engine.MemoryStore{}, false, func() {})
	match(t, `没收：「fix」要等的「nope」不存在`, ok(t, call(t, tools, "task_add", `{"tasks":[{"id":"fix","brief":"改","after":["nope"]}]}`)))
	match(t, `by: enum`, failed(t, call(t, tools, "task_add", `{"tasks":[{"id":"x","brief":"查","by":"helper"}]}`)))
	added := ok(t, call(t, tools, "task_add", `{"tasks":[{"id":"read","brief":"读代码"},{"id":"fix","title":"改 auth","brief":"改","after":["read"]}]}`))
	match(t, `任务（2 件，1 件可以做）`, added)
	match(t, `\[等着\] fix 改 auth（等 read）`, added)
	match(t, `\[可以做\] fix`, ok(t, call(t, tools, "task_update", `{"id":"read","state":"done","result":"在 jwt.go"}`)))
	match(t, `不能改成`, failed(t, call(t, tools, "task_update", `{"id":"read","state":"waiting"}`)))
	match(t, `read 读代码 → 在 jwt.go`, ok(t, call(t, tools, "task_graph", `{}`)))
	done := ok(t, call(t, tools, "task_update", `{"id":"fix","state":"done"}`))
	if !strings.HasSuffix(done, "都做完了，这张图收起来了。") {
		t.Fatalf("finished: %q", done)
	}
	eq(t, ok(t, call(t, tools, "task_graph", `{}`)), "现在没有任务。")
}

// A and B go out together; C waits for both, then goes; each comes back to the agent as an input.
func TestHelpersTasksGoOutWhenReadyAndComeBack(t *testing.T) {
	dir := home(t)
	store := &engine.MemoryStore{}
	var mu sync.Mutex
	var sent []string
	told := 0
	reply := step(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
		if strings.Contains(c.SystemPrompt, "派出去的帮手") {
			brief := MessageText(c.Messages[0].(ai.UserMessage))
			mu.Lock()
			if brief == "查 C" && !(contains(sent, "查 A") && contains(sent, "查 B")) {
				t.Errorf("C went out before A and B came back: %v", sent)
			}
			sent = append(sent, brief)
			mu.Unlock()
			return ai.FauxAssistantMessage(brief + " 做完了")
		}
		last := c.Messages[len(c.Messages)-1]
		if strings.Contains(MessageText(last), "〔任务〕") {
			mu.Lock()
			told++
			mu.Unlock()
			return ai.FauxAssistantMessage("收到")
		}
		if !answered(c) {
			return ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("task_add", `{"tasks":[`+
				`{"id":"a","brief":"查 A","by":"helper"},{"id":"b","brief":"查 B","by":"helper"},`+
				`{"id":"c","brief":"查 C","by":"helper","after":["a","b"]}]}`, "")})
		}
		return ai.FauxAssistantMessage("派好了")
	})
	steps := make([]ai.FauxResponseStep, 12)
	for i := range steps {
		steps[i] = reply
	}
	withAgent(t, dir, steps, func(r *rig) {
		r.ask("查三样")
		deadline := time.Now().Add(5 * time.Second)
		for {
			mu.Lock()
			n, back := len(sent), told
			mu.Unlock()
			g, _ := store.Load(context.Background())
			if n == 3 && back == 3 && len(g) == 0 {
				break
			}
			if time.Now().After(deadline) {
				t.Fatalf("sent %d, told %d, open %v", n, back, g)
			}
			time.Sleep(5 * time.Millisecond)
		}
	}, func(o *AgentOptions) {
		o.Tasks = store
		o.Schedules = new(false)
	})
}

func TestStoppingTheAgentCallsItsHelpersBack(t *testing.T) {
	dir := home(t)
	store := &engine.MemoryStore{}
	started := make(chan struct{})
	wait := TextTool(TextToolSpec[struct{}]{Name: "wait", Description: "等", Parameters: agentcore.ObjectSchema(nil),
		Run: func(ctx context.Context, _ struct{}, _ ToolContext) (string, error) {
			close(started)
			<-ctx.Done()
			return "", ctx.Err()
		}})
	reply := step(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
		if strings.Contains(c.SystemPrompt, "派出去的帮手") {
			return ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("wait", nil, "")})
		}
		if !answered(c) {
			return ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("task_add", `{"tasks":[{"id":"a","brief":"查 A","by":"helper"}]}`, "")})
		}
		return ai.FauxAssistantMessage("派好了")
	})
	withAgent(t, dir, []ai.FauxResponseStep{reply, reply, reply, reply}, func(r *rig) {
		eq(t, r.ask("查"), "派好了")
		<-started
		r.agent.Stop()
		g, _ := store.Load(context.Background())
		eq(t, g[0].State, engine.Waiting)
		eq(t, g[0].Tries, 0)
	}, func(o *AgentOptions) {
		o.Tools = []agentcore.AgentTool{wait}
		o.Tasks = store
		o.Schedules = new(false)
	})
}

func contains(list []string, s string) bool {
	for _, x := range list {
		if x == s {
			return true
		}
	}
	return false
}

// A run that stops with its own tasks ready is reminded, at most MaxNudges times while the graph stays the same.
func TestAStoppedRunIsRemindedOfItsOwnTasksAFewTimes(t *testing.T) {
	dir := home(t)
	var mu sync.Mutex
	nudged := 0
	reply := step(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
		last := MessageText(c.Messages[len(c.Messages)-1])
		if strings.Contains(last, "这一轮停了，还有 2 件你可以做：a、b") {
			mu.Lock()
			nudged++
			mu.Unlock()
			return ai.FauxAssistantMessage("还没空")
		}
		if !answered(c) {
			return ai.FauxAssistantMessage([]ai.Content{ai.FauxToolCall("task_add", `{"tasks":[{"id":"a","brief":"读"},{"id":"b","brief":"写"}]}`, "")})
		}
		return ai.FauxAssistantMessage("先这样")
	})
	steps := make([]ai.FauxResponseStep, 10)
	for i := range steps {
		steps[i] = reply
	}
	var events []AgentEvent
	withAgent(t, dir, steps, func(r *rig) {
		r.ask("拆一下")
		count := func() int {
			mu.Lock()
			defer mu.Unlock()
			return nudged
		}
		deadline := time.Now().Add(5 * time.Second)
		for count() < 2 && time.Now().Before(deadline) {
			time.Sleep(5 * time.Millisecond)
		}
		time.Sleep(300 * time.Millisecond)
		eq(t, count(), 2)
		events = r.all()
	}, func(o *AgentOptions) {
		o.Tasks = &engine.MemoryStore{}
		o.MaxNudges = 2
		o.Schedules = new(false)
	})
	changed := 0
	for _, e := range events {
		if c, ok := e.(TasksChanged); ok {
			changed++
			eq(t, len(c.Tasks), 2)
		}
	}
	eq(t, changed, 1) // the task was one change
}

func TestAFoldCarriesTheOpenGraph(t *testing.T) {
	store := &engine.MemoryStore{}
	runner := newTaskRunner(context.Background(), store, nil, 0, func(string) {})
	eq(t, runner.summary(), "")
	if _, err := store.Change(context.Background(), func(g []engine.Task) ([]engine.Task, error) {
		next, _ := engine.Add(g, []engine.Task{{ID: "a", Brief: "读"}})
		return next, nil
	}); err != nil {
		t.Fatal(err)
	}
	folded := summaryOf(compactionPlan{}, "之前聊了 auth", "", CompactionOptions{Append: runner.summary})
	eq(t, folded.Summary, "之前聊了 auth\n\n【整理对话时的任务，以 tasks 为准】\n任务（1 件，1 件可以做）：\n- [可以做] a 读")
}
