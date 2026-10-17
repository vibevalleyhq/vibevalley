package manager

import (
	"context"
	"strings"
	"testing"
	"time"
	"vibevalley/pkg/agentcore"

	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/ai"
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
	w.f.Manager.send("chat", w.f.Channel.General(), true)
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
			_ = fm.here()
			return agentcore.TextResult("stopped"), nil
		},
	})})
	w.faux.SetResponses(ai.FauxResponseFactory(func(ai.Context, ai.StreamOptions, ai.FauxProviderState, ai.Model) ai.AssistantMessage {
		return ai.FauxAssistantMessage(ai.FauxToolCall("wait", map[string]any{}, ""))
	}))
	fm.send("wait", w.f.Channel.General(), true)
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
	line := managerLastLine(c)
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

func TestEachAnswerLeavesItsTokensInTheLog(t *testing.T) {
	w := managerOpen(t)
	answer := ai.FauxAssistantMessage("收到")
	answer.Usage = ai.Usage{Input: 8_900, CacheRead: 41_200, Output: 310, TotalTokens: 50_410}
	w.faux.SetResponses(answer)
	w.f.Manager.send("在吗", w.f.Channel.General(), true)
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
	testkit.Eq(t, managerUsageText(protocol.EventTokens{Input: 1_000, CacheRead: 1_000, Output: 1_234_567}, "memory,tools"), "缓存命中 50%：读缓存 1 000，没命中 1 000，输出 1 234 567；开头变了：记性、工具", "changed")
	testkit.Eq(t, managerUsageText(protocol.EventTokens{Output: 12}, ""), "没报读了多少：输出 12", "no input")
}
