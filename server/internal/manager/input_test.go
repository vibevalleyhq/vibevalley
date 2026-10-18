package manager

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/db/generated"

	vvagent "vibevalley/internal/agent/brain"
	"vibevalley/internal/memory"
	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/ai"
	"vibevalley/pkg/x/clock"
)

func TestQueuedManagerInputKeepsItsReplyChannelAndSelection(t *testing.T) {
	w := managerOpen(t)
	fm := w.f.Manager.manager
	other, err := w.f.Channel.OpenChannel("other", "", "")
	if err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}), make(chan struct{})
	w.faux.SetResponses(
		ai.FauxResponseFactory(func(ai.Context, ai.StreamOptions, ai.FauxProviderState, ai.Model) ai.AssistantMessage {
			close(started)
			<-release
			return ai.FauxAssistantMessage("answer A")
		}),
		ai.FauxResponseFactory(func(ai.Context, ai.StreamOptions, ai.FauxProviderState, ai.Model) ai.AssistantMessage {
			return ai.FauxAssistantMessage("answer B")
		}),
	)
	first := managerInput{Conversation: w.f.Channel.General(), Agent: "agent-a"}
	second := managerInput{Conversation: other.ID, Agent: "agent-b"}
	fm.sendInput("A", first, true)
	<-started
	fm.sendInput("B", second, false)
	if got := fm.requestInput(); got.Conversation != first.Conversation || got.Agent != first.Agent {
		t.Fatalf("queued input replaced current request: %+v", got)
	}
	close(release)
	testkit.Until(t, "B delivered", func() bool {
		for _, m := range protocol.MessagesIn(w.f.Core.State().Chat, other.ID) {
			if m.Final && m.Text == "answer B" {
				return true
			}
		}
		return false
	})
	for _, pair := range []struct{ id, text string }{{first.Conversation, "answer A"}, {other.ID, "answer B"}} {
		found := false
		for _, m := range protocol.MessagesIn(w.f.Core.State().Chat, pair.id) {
			if m.From == protocol.ManagerAgent && m.Final {
				if m.Text != pair.text {
					t.Fatalf("wrong reply in %s: %s", pair.id, m.Text)
				}
				found = true
			}
		}
		if !found {
			t.Fatalf("missing %s", pair.text)
		}
	}
}

func TestNewVoiceCallerDoesNotReceiveOlderChatAnswer(t *testing.T) {
	w := managerOpen(t)
	started, release := make(chan struct{}), make(chan struct{})
	w.faux.SetResponses(
		ai.FauxResponseFactory(func(ai.Context, ai.StreamOptions, ai.FauxProviderState, ai.Model) ai.AssistantMessage {
			close(started)
			<-release
			return ai.FauxAssistantMessage("older chat answer")
		}),
		ai.FauxResponseFactory(func(ai.Context, ai.StreamOptions, ai.FauxProviderState, ai.Model) ai.AssistantMessage {
			return ai.FauxAssistantMessage("voice answer")
		}),
	)
	w.f.Manager.send(sourceOwner, "chat", w.f.Channel.General(), true)
	<-started
	ctx, cancel := context.WithCancel(w.ctx)
	defer cancel()
	stream := w.f.Manager.Call(ctx, "voice")
	// Wait for the voice message to be submitted before releasing the earlier model request.
	testkit.Until(t, "voice submitted", func() bool {
		w.f.Manager.starting.Lock()
		brain := w.f.Manager.brain
		w.f.Manager.starting.Unlock()
		return brain != nil && brain.Core.HasQueuedMessages()
	})
	close(release)
	var received strings.Builder
	for part := range stream {
		received.WriteString(part)
	}
	if got := received.String(); got != "voice answer\n" {
		t.Fatalf("voice received: %q", got)
	}
}

func TestManagerShutdownDoesNotHoldInputReadLock(t *testing.T) {
	w := managerOpen(t)
	fm := w.f.Manager.manager
	brain, err := fm.brainOf()
	if err != nil {
		t.Fatal(err)
	}
	entered := make(chan struct{})
	brain.Core.SetTools([]agentcore.AgentTool{agentcore.DefineTool(agentcore.ToolSpec[struct{}]{
		Name: "wait", Parameters: agentcore.ObjectSchema(nil),
		Execute: func(ctx context.Context, _ string, _ struct{}, _ agentcore.AgentToolUpdateCallback) (agentcore.AgentToolResult, error) {
			close(entered)
			<-ctx.Done()
			_ = fm.requestInput()
			return agentcore.TextResult("stopped"), nil
		},
	})})
	w.faux.SetResponses(ai.FauxResponseFactory(func(ai.Context, ai.StreamOptions, ai.FauxProviderState, ai.Model) ai.AssistantMessage {
		return ai.FauxAssistantMessage(ai.FauxToolCall("wait", map[string]any{}, ""))
	}))
	fm.send(sourceOwner, "wait", w.f.Channel.General(), true)
	<-entered
	stopped := make(chan struct{})
	go func() { fm.OnStop(); close(stopped) }()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("shutdown waits on its own input lock")
	}
}

func TestFarmNewsAndInstructionAreOneModelInput(t *testing.T) {
	w := managerOpen(t)
	w.enableLab(t)
	hired := w.f.Issue.Hire(w.ctx, fixture.Lab(t), "source for digest", "digest", session.HireOptions{})
	if hired.Session == nil {
		t.Fatal(hired.Refused)
	}
	testkit.Until(t, "report reaches the channel", func() bool {
		for _, m := range w.f.Core.State().Chat.Messages {
			if m.From == hired.Session.ID && m.Kind == protocol.MessageKindReport {
				return true
			}
		}
		return false
	})
	entered, release := make(chan ai.Context, 1), make(chan struct{})
	w.faux.SetResponses(ai.FauxResponseFactory(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
		entered <- c
		<-release
		return ai.FauxAssistantMessage("combined answer")
	}))
	w.f.Manager.sendInput("用户的唯一指令", managerInput{Conversation: w.f.Channel.General(), Quiet: true}, true)
	c := <-entered
	close(release)
	line := managerLastInput(c)
	if !strings.Contains(line, "这期间田头上的汇报") || !strings.Contains(line, "做完了") || !strings.Contains(line, "用户的唯一指令") {
		t.Fatalf("first request split the input: %q", line)
	}
	w.f.Manager.starting.Lock()
	brain := w.f.Manager.brain
	w.f.Manager.starting.Unlock()
	if err := brain.Core.WaitForIdle(w.ctx); err != nil {
		t.Fatal(err)
	}
	if got := len(w.seen()); got != 1 {
		t.Fatalf("one input made %d model requests", got)
	}
}

func TestCanceledQueuedInputLeavesDigestForNextConsumedInput(t *testing.T) {
	w := managerOpen(t)
	started, release := make(chan struct{}), make(chan struct{})
	w.faux.SetResponses(ai.FauxResponseFactory(func(ai.Context, ai.StreamOptions, ai.FauxProviderState, ai.Model) ai.AssistantMessage {
		close(started)
		<-release
		return ai.FauxAssistantMessage("old response")
	}))
	fm := w.f.Manager.manager
	fm.send(sourceOwner, "hold", w.f.Channel.General(), true)
	<-started
	w.enableLab(t)
	hired := w.f.Issue.Hire(w.ctx, fixture.Lab(t), "digest source", "digest", session.HireOptions{})
	if hired.Session == nil {
		close(release)
		t.Fatal(hired.Refused)
	}
	digest := testkit.Await(t, "pending report", func() ([]protocol.InboxMessage, bool) { d := w.f.Channel.ManagerDigest(); return d, len(d) > 0 })
	fm.sendInput("cancel this", managerInput{Conversation: w.f.Channel.General()}, false)
	fm.starting.Lock()
	brain := fm.brain
	fm.starting.Unlock()
	stopped := make(chan struct{})
	go func() { brain.Stop(); close(stopped) }()
	testkit.Until(t, "queued input discarded", func() bool { return !brain.Core.HasQueuedMessages() })
	close(release)
	<-stopped
	if err := brain.Core.WaitForIdle(w.ctx); err != nil {
		t.Fatal(err)
	}
	if d := w.f.Channel.ManagerDigest(); len(d) != len(digest) {
		t.Fatalf("queued input consumed report: %+v", d)
	}
	w.faux.SetResponses(ai.FauxResponseFactory(func(ai.Context, ai.StreamOptions, ai.FauxProviderState, ai.Model) ai.AssistantMessage {
		return ai.FauxAssistantMessage("read now")
	}))
	fm.sendInput("consume this", managerInput{Conversation: w.f.Channel.General()}, true)
	testkit.Until(t, "execution acknowledges report", func() bool { return len(w.f.Channel.ManagerDigest()) == 0 })
	runs, err := generated.New(w.f.DB).RunsOfSession(context.Background(), protocol.ManagerAgent)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, r := range runs {
		if r.Heard.Valid && strings.Contains(r.Heard.String, digest[0].ID) {
			found = true
		}
	}
	if !found {
		t.Fatal("receipt is not attached to a persisted run")
	}
}

func TestEachAnswerLeavesItsTokensInTheLog(t *testing.T) {
	w := managerOpen(t)
	answer := ai.FauxAssistantMessage("收到")
	answer.Usage = ai.Usage{Input: 8_900, CacheRead: 41_200, Output: 310, TotalTokens: 50_410}
	w.faux.SetResponses(answer)
	w.f.Manager.send(sourceOwner, "在吗", w.f.Channel.General(), true)
	usage := testkit.Await(t, "the usage", func() (protocol.SessionEvent, bool) {
		for _, e := range w.f.Session.Events(protocol.ManagerAgent, "") {
			if e.Type == protocol.SessionEventTypeLLMUsage {
				return e, true
			}
		}
		return protocol.SessionEvent{}, false
	})
	testkit.Eq(t, *usage.Tokens, protocol.EventTokens{Input: 8_900, CacheRead: 41_200, Output: 310}, "tokens")
	testkit.Eq(t, usage.Text, "缓存命中 82%：读缓存 41 200，没命中 8 900，输出 310", "text")
}

func TestUsageText(t *testing.T) {
	testkit.Eq(t, managerUsageText(protocol.EventTokens{Input: 1_000, CacheRead: 1_000, Output: 1_234_567}, []string{"memory", "tools"}), "缓存命中 50%：读缓存 1 000，没命中 1 000，输出 1 234 567；开头变了：记性、工具", "changed")
	testkit.Eq(t, managerUsageText(protocol.EventTokens{Output: 12}, nil), "没报读了多少：输出 12", "no input")
}

func TestTheSituationIsWholeOnlyAfterAFold(t *testing.T) {
	w := managerOpen(t)
	fm := w.f.Manager.manager
	ask := func(words string) string {
		t.Helper()
		before := len(w.seen())
		fm.send(sourceOwner, words, w.f.Channel.General(), true)
		c := testkit.Await(t, "the request", func() (ai.Context, bool) {
			seen := w.seen()
			if len(seen) <= before {
				return ai.Context{}, false
			}
			return seen[before], true
		})
		testkit.Until(t, "idle", func() bool { return !fm.brain.Busy() })
		return managerLastInput(c)
	}
	if first := ask("一"); !strings.Contains(first, "【农场现状】") {
		t.Fatalf("first %q", first)
	}
	if _, err := w.f.Channel.OpenChannel("clock-in", "", ""); err != nil {
		t.Fatal(err)
	}
	second := ask("二")
	if strings.Contains(second, "【农场现状】") || !strings.HasSuffix(second, "【农场变了】\n+ #clock-in\n+   （没有帮工）\n\n[来源：主人]\n二") {
		t.Fatalf("second %q", second)
	}
	if third := ask("三"); strings.Contains(third, "【农场") {
		t.Fatalf("third %q", third)
	}
	fm.event(vvagent.CompactionEnded{Compaction: &vvagent.CompactionSummaryMessage{Summary: "摘要"}})
	if fourth := ask("四"); !strings.Contains(fourth, "【农场现状】") {
		t.Fatalf("after a fold %q", fourth)
	}
}

func TestOnlyItsOwnScheduleSoonKeepsTheManagerFromFoldingIdle(t *testing.T) {
	w := managerOpen(t)
	fm := w.f.Manager.manager
	in := func(minutes int64) protocol.ScheduleWhen {
		return protocol.ScheduleWhen{Value: protocol.ScheduleWhenOnce{At: clock.NowMs() + minutes*60_000}}
	}
	if _, err := w.f.Schedule.Add(protocol.ScheduleRequest{Name: "晚些", Text: "看看", When: in(30)}, protocol.ScheduleByOwner, true); err != nil {
		t.Fatal(err)
	}
	ops, err := w.f.Channel.OpenChannel("ops", "", "demo")
	if err != nil {
		t.Fatal(err)
	}
	lab := "lab"
	if _, err := w.f.Schedule.Add(protocol.ScheduleRequest{Name: "巡检", Text: "跑一遍", Channel: &ops.ID, Agent: &lab, When: in(5)}, protocol.ScheduleByOwner, true); err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, fm.wakeSoon(10*time.Minute), false, "a helper's, and its own far off")
	if _, err := w.f.Schedule.Add(protocol.ScheduleRequest{Name: "回头看", Text: "看进度", When: in(5)}, protocol.ScheduleByOwner, true); err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, fm.wakeSoon(10*time.Minute), true, "its own in 5 minutes")
}

func TestInputReadBackFromTheFileKeepsItsRouting(t *testing.T) {
	line := `{"role":"custom","customType":"managerInput","content":"主人说：在吗","display":true,"details":{"conversation":"c-1","agent":"lab","issue":"i-1"},"timestamp":1}`
	m, err := vvagent.DecodeMessage([]byte(line))
	if err != nil {
		t.Fatal(err)
	}
	input, ok := managerInputOf(m)
	testkit.Eq(t, ok, true, "known")
	testkit.Eq(t, input, managerInput{Conversation: "c-1", Agent: "lab", Issue: "i-1"}, "input")
}

func TestARestartGoesOnWithTheRunItCut(t *testing.T) {
	cfg := fixture.Config(t.TempDir(), t.TempDir(), filepath.Join(t.TempDir(), "vibevalley.db"))
	// Slow enough that the second answer is still coming when the farm stops.
	before := ai.FauxProvider(ai.FauxProviderOptions{Delay: 5 * time.Millisecond})
	before.SetResponses(
		ai.FauxAssistantMessage(ai.FauxToolCall("dispatch", map[string]any{"brief": "加个 README", "project": "demo"}, "")),
		ai.FauxAssistantMessage(strings.Repeat("还在说", 400)),
	)
	w := managerStart(t, cfg, before)
	clockIn, err := w.f.Channel.OpenChannel("clock-in", "", "")
	if err != nil {
		t.Fatal(err)
	}
	w.f.Manager.send(sourceOwner, "主人说：在 demo 里加个 README", clockIn.ID, true)
	file := filepath.Join(memory.ManagerHome(cfg.Home), protocol.ManagerAgent+".jsonl")
	testkit.Until(t, "the tool's result saved", func() bool {
		data, _ := os.ReadFile(file)
		return strings.Contains(string(data), `"role":"toolResult"`)
	})
	testkit.Until(t, "the second answer coming", func() bool { return len(before.State().Contexts) == 2 })
	w.f.Close()
	if !vvagent.SessionUnfinished(file) {
		t.Fatal("the cut run looks finished")
	}

	after := ai.FauxProvider(ai.FauxProviderOptions{})
	after.SetResponses(ai.FauxResponseFactory(func(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
		if result, ok := managerAnsweredCtx(c); ok && strings.Contains(result, "派") {
			return ai.FauxAssistantMessage("接着说完：派好了")
		}
		return ai.FauxAssistantMessage("不对")
	}))
	again := managerStart(t, cfg, after)
	said := testkit.Await(t, "the run gone on with", func() (string, bool) {
		for _, m := range protocol.MessagesIn(again.f.Core.State().Chat, clockIn.ID) {
			if m.From == protocol.ManagerAgent && m.Final && !strings.HasPrefix(m.Text, "派 ") {
				return m.Text, true
			}
		}
		return "", false
	})
	testkit.Eq(t, said, "接着说完：派好了", "answer")
	testkit.Eq(t, len(after.State().Contexts), 1, "requests")
	testkit.Eq(t, len(again.f.Session.Roster()), 1, "helpers")
}

func TestEverySourceHasItsHead(t *testing.T) {
	heads := map[string]bool{}
	for _, source := range managerSources {
		head := managerHead(source)
		if !strings.HasPrefix(head, "[来源：") || heads[head] {
			t.Fatalf("%s: %q", source, head)
		}
		heads[head] = true
	}
	defer func() {
		if recover() == nil {
			t.Fatal("an unknown source has a head")
		}
	}()
	managerHead("")
}
