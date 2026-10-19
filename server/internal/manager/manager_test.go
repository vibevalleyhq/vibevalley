package manager

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/internal/agent/brain"
	"vibevalley/internal/base"
	"vibevalley/internal/channel"
	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/ai"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

type managerWorld struct {
	f    *world
	faux *ai.FauxProviderHandle
	ctx  context.Context

	mu     sync.Mutex
	tokens map[string]string
}

func managerUserText(m ai.Message) (string, bool) {
	u, ok := m.(ai.UserMessage)
	if !ok {
		return "", false
	}
	return u.Content.Words("\n"), true
}

func managerLastInput(c ai.Context) string {
	for i := len(c.Messages) - 1; i >= 0; i-- {
		if text, ok := managerUserText(c.Messages[i]); ok {
			return text
		}
	}
	return ""
}

var managerInputHeads = []string{"【现在】", "【农场现状】", "【农场变了】", "【记性有更新】", "这期间田头上的汇报"}

func managerLastLine(c ai.Context) string { return managerWords(managerLastInput(c)) }

// An input without what sendInput puts before the words.
func managerWords(input string) string {
	blocks := strings.Split(input, "\n\n")
	for len(blocks) > 1 && slices.ContainsFunc(managerInputHeads, func(head string) bool { return strings.HasPrefix(blocks[0], head) }) {
		blocks = blocks[1:]
	}
	return strings.Join(blocks, "\n\n")
}

func managerAnsweredCtx(c ai.Context) (string, bool) {
	if len(c.Messages) == 0 {
		return "", false
	}
	if r, ok := c.Messages[len(c.Messages)-1].(ai.ToolResultMessage); ok {
		return ai.ContentText(r.Content, "\n"), true
	}
	return "", false
}

func managerSinceAnswer(c ai.Context) string {
	from := 0
	for i, m := range c.Messages {
		if m.Role() == "assistant" {
			from = i + 1
		}
	}
	var said []string
	for _, m := range c.Messages[from:] {
		if text, ok := managerUserText(m); ok {
			said = append(said, text)
		}
	}
	return strings.Join(said, "\n")
}

var managerAsked = regexp.MustCompile(`(?m)加个 (README|CHANGELOG)$`)

func managerRespond(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
	if result, ok := managerAnsweredCtx(c); ok {
		return ai.FauxAssistantMessage("好，" + str.Head(result, 2) + "了")
	}
	if asked := managerAsked.FindString(managerSinceAnswer(c)); asked != "" {
		args := map[string]any{"brief": asked, "project": "demo"}
		if strings.Contains(asked, "CHANGELOG") {
			args = map[string]any{"brief": asked, "project": "notes", "agent": "lab"}
		}
		return ai.FauxAssistantMessage(ai.FauxToolCall("dispatch", args, ""))
	}
	if strings.Contains(managerLastLine(c), "定时任务") {
		return ai.FauxAssistantMessage("到点了，看了一眼")
	}
	return ai.FauxAssistantMessage("收到")
}

func managerOpen(t *testing.T) *managerWorld {
	t.Helper()
	return managerOpenWith(t, ai.FauxProviderOptions{}, managerRespond)
}

func managerOpenWith(t *testing.T, options ai.FauxProviderOptions, respond func(ai.Context, ai.StreamOptions, ai.FauxProviderState, ai.Model) ai.AssistantMessage) *managerWorld {
	t.Helper()
	faux := ai.FauxProvider(options)
	steps := make([]ai.FauxResponseStep, 100)
	for i := range steps {
		steps[i] = ai.FauxResponseFactory(respond)
	}
	faux.SetResponses(steps...)
	return managerStart(t, fixture.Config(t.TempDir(), t.TempDir(), ":memory:"), faux)
}

func managerStart(t *testing.T, cfg base.Config, faux *ai.FauxProviderHandle) *managerWorld {
	t.Helper()
	cfg.Schedule.TickMs = 50
	// Rounds are run by hand here.
	cfg.Patrol.HeartbeatMinutes = 0
	f, err := newWorld(cfg)
	if err != nil {
		t.Fatal(err)
	}
	w := &managerWorld{f: f, tokens: map[string]string{}}
	pi := oartest.Runtime(oartest.Options{ID: "pi", Turn: func(turn *oartest.Turn) error {
		for _, s := range turn.Options.MCPServers {
			if s.Name == "farm" {
				w.mu.Lock()
				w.tokens[turn.Options.Cwd] = strings.TrimPrefix(s.Headers["authorization"], "Bearer ")
				w.mu.Unlock()
			}
		}
		turn.Say("做完了")
		return nil
	}})
	registry, err := oar.NewRuntimeRegistry(pi)
	if err != nil {
		t.Fatal(err)
	}
	f.Runtime.UseRegistry(registry)
	f.Runtime.Probe = func(_ context.Context, id string) protocol.RuntimeInfo {
		if id != "pi" {
			return protocol.RuntimeInfo{ID: id, Installation: protocol.Installation{Value: protocol.InstallationNotFound{}}, Settings: f.Agent.Settings(id)}
		}
		return fixture.Pi()
	}
	w.faux = faux
	f.Manager.llm = &brain.LLM{Model: w.faux.GetModel()}
	w.ctx = ai.WithProviders(context.Background(), w.faux.Provider)
	if err := f.Start(w.ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	return w
}

func (w *managerWorld) seen() []ai.Context { return w.faux.State().Contexts }

func (w *managerWorld) managerSaid(t *testing.T, count int) []string {
	t.Helper()
	return testkit.Await(t, "the manager's words", func() ([]string, bool) {
		var said []string
		for _, m := range protocol.MessagesIn(w.f.Core.State().Chat, w.f.Channel.General()) {
			if m.From == protocol.ManagerAgent && m.Kind == protocol.MessageKindChat && m.Final {
				said = append(said, m.Text)
			}
		}
		return said, len(said) >= count
	})
}

func (w *managerWorld) enableLab(t *testing.T) {
	t.Helper()
	lab := fixture.Lab(t)
	lab.Enabled = true
	if _, err := w.f.Agent.SaveAgent(lab); err != nil {
		t.Fatal(err)
	}
}

func TestManagerDispatchesAndHearsVoiceInChat(t *testing.T) {
	w := managerOpen(t)
	f := w.f
	w.enableLab(t)
	if err := f.Manager.Say(w.ctx, "帮我在 demo 里加个 README", Pick{}, nil, ""); err != nil {
		t.Fatal(err)
	}
	if said := w.managerSaid(t, 1); !slices.Equal(said, []string{"好，已在了"}) {
		t.Fatalf("said %q", said)
	}
	first := w.seen()[0]
	if !regexp.MustCompile(`^【现在】\d{4}/\d+/\d+ \d\d:\d\d\n\n【农场现状】[\s\S]*可以派的帮工：\n- `).MatchString(managerLastInput(first)) || strings.Contains(first.SystemPrompt, "【农场现状】") {
		t.Fatalf("input: %s", managerLastInput(first))
	}
	if line := managerLastLine(first); line != "[来源：主人]\n主人说：帮我在 demo 里加个 README" {
		t.Fatalf("line %q", line)
	}
	trail := testkit.Await(t, "its log", func() ([]protocol.SessionEvent, bool) {
		events := slices.DeleteFunc(f.Session.Events(protocol.ManagerAgent, ""), func(e protocol.SessionEvent) bool { return e.Type == protocol.SessionEventTypeLLMUsage })
		return events, len(events) >= 6 && events[len(events)-1].Type == protocol.SessionEventTypeRunEnd
	})
	last := trail[len(trail)-5 : len(trail)-1]
	asked, tool, result, answer := last[0], last[1], last[2], last[3]
	if result.Type != protocol.SessionEventTypeToolResult || result.Call == nil || *result.Call != tool.Seq || result.Ok == nil || !*result.Ok {
		t.Fatalf("result %+v", result)
	}
	if asked.Type != protocol.SessionEventTypeUserMessage || !strings.HasPrefix(asked.Text, "[来源：主人]") || !strings.Contains(asked.Text, "加个 README") {
		t.Fatalf("asked %+v", asked)
	}
	if tool.Tool == nil || *tool.Tool != "dispatch" || tool.Text != "派活：demo" ||
		tool.Input == nil || !strings.Contains(*tool.Input, `"project":"demo"`) {
		t.Fatalf("tool %+v", tool)
	}
	if answer.Text != "好，已在了" {
		t.Fatalf("answer %+v", answer)
	}
	roster := f.Session.Roster()
	if len(roster) != 1 || roster[0].Place.Project != "demo" {
		t.Fatalf("roster %+v", roster)
	}
	testkit.Until(t, "its report", func() bool {
		all := f.Session.Roster()
		return len(all) == 1 && all[0].Session.LastRun != nil
	})

	before := len(w.seen())
	f.Manager.Heard("随便说一句", "", "")
	testkit.Until(t, "the manager asked", func() bool { return len(w.seen()) > before })
	testkit.Settle()
	if said := w.managerSaid(t, 2); said[len(said)-1] != "收到" {
		t.Fatalf("heard by voice, it said %q", said)
	}
	spoken := slices.IndexFunc(protocol.MessagesIn(f.Core.State().Chat, f.Channel.General()), func(m protocol.ChatMessage) bool {
		return m.From == "user" && m.Text == "随便说一句" && m.Spoken
	})
	if spoken < 0 {
		t.Fatal("what was said on the call is not in 田头")
	}
	heard := 0
	for _, c := range w.seen()[before:] {
		if strings.Contains(managerLastLine(c), "随便说一句") {
			heard++
		}
	}
	if heard != 1 {
		t.Fatalf("the words on the call reached the manager %d times", heard)
	}
	if line := managerLastLine(w.seen()[len(w.seen())-1]); !strings.Contains(line, "语音那边已经回答了") {
		t.Fatalf("line %q", line)
	}
	kept, err := os.ReadFile(filepath.Join(f.Home, protocol.ManagerAgent, "manager.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`"customType":"managerInput"[^\n]*这期间田头上的汇报[^\n]*做完了[^\n]*语音那边已经回答了`).Match(kept) {
		t.Fatalf("no farm news kept:\n%s", kept)
	}
	if !regexp.MustCompile(`"customType":"managerInput"[^\n]*"source":"owner","owner":true`).Match(kept) {
		t.Fatalf("no source kept:\n%s", kept)
	}
	if !strings.Contains(string(kept), "【农场现状】") {
		t.Fatal("the situation is not in the conversation")
	}
}

func TestManagerCallStreamsItsWords(t *testing.T) {
	w := managerOpen(t)
	f := w.f
	before := len(w.seen())
	var words strings.Builder
	for piece := range f.Manager.Call(w.ctx, "现在地里怎么样") {
		words.WriteString(piece)
	}
	if words.String() != "收到\n" {
		t.Fatalf("words %q", words.String())
	}
	seen := w.seen()
	if !regexp.MustCompile(`主人在电话里说的[\s\S]*主人说：现在地里怎么样`).MatchString(managerLastLine(seen[len(seen)-1])) || len(seen) != before+1 {
		t.Fatalf("asked %d times; last %q", len(seen)-before, managerLastLine(seen[len(seen)-1]))
	}
	call := func() []string {
		var kept []string
		for _, m := range protocol.MessagesIn(f.Core.State().Chat, f.Channel.General()) {
			if m.Spoken || m.From == protocol.ManagerAgent {
				kept = append(kept, m.From+"："+m.Text)
			}
		}
		return kept
	}
	if kept := testkit.Await(t, "the call in 田头", func() ([]string, bool) { k := call(); return k, len(k) == 2 }); !slices.Equal(kept, []string{"user：现在地里怎么样", "manager：收到"}) {
		t.Fatalf("田头 %q", kept)
	}
}

func TestManagerSchedulesComeDue(t *testing.T) {
	w := managerOpen(t)
	f := w.f
	made, err := f.Schedule.Add(protocol.ScheduleRequest{Name: "看进度", Text: "看看帮工们的进度", When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenOnce{At: clock.NowMs() + 150}}}, protocol.ScheduleByOwner, true)
	if err != nil {
		t.Fatal(err)
	}
	if made.Channel != f.Channel.General() {
		t.Fatalf("channel %s", made.Channel)
	}
	if said := w.managerSaid(t, 1); !slices.Equal(said, []string{"到点了，看了一眼"}) {
		t.Fatalf("said %q", said)
	}
	i := slices.IndexFunc(protocol.MessagesIn(f.Core.State().Chat, f.Channel.General()), func(m protocol.ChatMessage) bool { return m.Kind == protocol.MessageKindNotice })
	if i < 0 || protocol.MessagesIn(f.Core.State().Chat, f.Channel.General())[i].Text != "⏰ 定时「看进度」到点了：看看帮工们的进度" {
		t.Fatal("no notice of it")
	}
	woke := slices.IndexFunc(w.seen(), func(c ai.Context) bool { return strings.Contains(managerLastLine(c), "定时任务") })
	if woke < 0 {
		t.Fatal("never woken")
	}
	if c := w.seen()[woke]; !regexp.MustCompile(`^\[来源：定时\]\n【定时任务「看进度」到点了】\n看看帮工们的进度\n\n这是 #田头 的定时`).MatchString(managerLastLine(c)) ||
		!strings.Contains(managerLastInput(c), "【农场") {
		t.Fatalf("woken with %q", managerLastLine(c))
	}
	if i := slices.IndexFunc(f.Schedule.List(), func(s protocol.Schedule) bool { return s.ID == made.ID }); i < 0 || f.Schedule.List()[i].Enabled {
		t.Fatal("still enabled")
	}
	answered := testkit.Await(t, "its issue answered", func() (protocol.Issue, bool) {
		i, ok := f.Issue.OfSchedule(made.ID)
		return i, ok && i.Closed != nil && *i.Closed == protocol.IssueCloseAnswered
	})
	testkit.Eq(t, *answered.Assignee, protocol.ManagerAgent, "an issue for the manager")
	runs, err := f.Session.Runs(answered.ID)
	if err != nil || len(runs) != 1 {
		t.Fatalf("runs %+v %v", runs, err)
	}
	testkit.Eq(t, runs[0].Session, protocol.ManagerAgent, "the manager's run")
	testkit.Eq(t, runs[0].TriggeredBy.Kind, protocol.RunTriggerKindSchedule, "started by the schedule")
	testkit.Eq(t, *runs[0].TriggeredBy.Schedule, made.ID, "this one")
	testkit.Eq(t, *runs[0].Outcome, protocol.OutcomeCompleted, "and done")

	w.enableLab(t)
	asked := len(w.seen())
	ops, err := f.Channel.OpenChannel("ops", "", "demo")
	if err != nil {
		t.Fatal(err)
	}
	lab := "lab"
	if _, err := f.Schedule.Add(protocol.ScheduleRequest{Name: "巡检", Text: "跑一遍检查", Channel: &ops.ID, Agent: &lab, When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenOnce{At: clock.NowMs() + 150}}}, protocol.ScheduleByOwner, true); err != nil {
		t.Fatal(err)
	}
	sent := testkit.Await(t, "the session sent", func() (session.Roster, bool) {
		for _, r := range f.Session.Roster() {
			if r.Session.Brief == "巡检\n\n跑一遍检查" {
				return r, true
			}
		}
		return session.Roster{}, false
	})
	if sent.Session.Channel == nil || *sent.Session.Channel != ops.ID || sent.Place.Project != "demo" {
		t.Fatalf("sent %+v", sent)
	}
	if issue, err := f.Issue.Get(sent.Session.ID); err != nil || issue.Schedule == nil || issue.Title != "巡检" {
		t.Fatalf("its issue: %+v %v", issue, err)
	}
	if len(w.seen()) != asked {
		t.Fatal("the manager was asked")
	}
	general := f.Channel.General()
	_, err = f.Schedule.Add(protocol.ScheduleRequest{Name: "x", Text: "y", Channel: &general, Agent: &lab, When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenEvery{Minutes: 5}}}, protocol.ScheduleByOwner, true)
	if err == nil || !strings.Contains(err.Error(), "默认项目") {
		t.Fatalf("err %v", err)
	}
}

func TestManagerHearsThePatrol(t *testing.T) {
	w := managerOpen(t)
	f := w.f
	w.enableLab(t)
	if err := f.Manager.Say(w.ctx, "帮我在 notes 里加个 CHANGELOG", Pick{}, nil, ""); err != nil {
		t.Fatal(err)
	}
	testkit.Until(t, "the work ripe", func() bool {
		return slices.ContainsFunc(f.Session.Roster(), func(r session.Roster) bool {
			_, ripe := r.Session.Phase.Value.(protocol.PhaseRipe)
			return r.Session.Brief == "加个 CHANGELOG" && ripe
		})
	})
	hoursOn := func(h float64) func() int64 {
		return func() int64 { return clock.NowMs() + int64(h*3_600_000) }
	}
	patrol := regexp.MustCompile(`^\[来源：巡查\]\n【巡查】[\s\S]*「加个 CHANGELOG」`)
	ours := func(c ai.Context) bool { return patrol.MatchString(managerLastLine(c)) }
	f.Manager.Patrol()
	testkit.Settle()
	if slices.ContainsFunc(w.seen(), func(c ai.Context) bool { return strings.Contains(managerLastLine(c), "【巡查】") }) {
		t.Fatal("not yet past its grace")
	}
	f.Manager.PatrolNow = hoursOn(3)
	f.Manager.Patrol()
	testkit.Until(t, "the patrol's news", func() bool { return slices.ContainsFunc(w.seen(), ours) })
	line := managerLastLine(w.seen()[slices.IndexFunc(w.seen(), ours)])
	if !regexp.MustCompile(`^\[来源：巡查\]\n【巡查】#田头 里有几件事放着没人管：\n(- .+\n)*- .+（w\d+）的活做完 3 小时了还没收：「加个 CHANGELOG」`).MatchString(line) {
		t.Fatalf("patrol %q", line)
	}
	// Each request carries the whole conversation: count this work's patrol lines in the latest.
	f.Manager.PatrolNow = hoursOn(3.5)
	f.Manager.Patrol()
	testkit.Settle()
	latest := w.seen()[len(w.seen())-1]
	n := 0
	for _, m := range latest.Messages {
		if text, ok := managerUserText(m); ok && patrol.MatchString(managerWords(text)) {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("reported %d times", n)
	}
}

func TestManagerTellsItsStartFailure(t *testing.T) {
	cfg := fixture.Config(t.TempDir(), t.TempDir(), ":memory:")
	f, err := newWorld(cfg)
	if err != nil {
		t.Fatal(err)
	}
	manager := *f.Agent.Agent(protocol.ManagerAgent)
	manager.Model = "openai/gpt"
	if _, err := f.Agent.SaveAgent(manager); err != nil {
		t.Fatal(err)
	}
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	var words []string
	for piece := range f.Manager.Call(context.Background(), "在吗") {
		words = append(words, piece)
	}
	if len(words) != 1 || !strings.Contains(words[0], "只接 DeepSeek") {
		t.Fatalf("words %q", words)
	}
	said := testkit.Await(t, "the refusal on 田头", func() (string, bool) {
		for _, m := range protocol.MessagesIn(f.Core.State().Chat, f.Channel.General()) {
			if m.From == protocol.ManagerAgent {
				return m.Text, true
			}
		}
		return "", false
	})
	if !strings.HasPrefix(said, "我这边起不来：") {
		t.Fatalf("said %q", said)
	}
	words = nil
	for piece := range f.Manager.Call(context.Background(), "还在吗") {
		words = append(words, piece)
	}
	if len(words) != 1 {
		t.Fatalf("the call hears why again: %q", words)
	}
	testkit.Settle()
	refusals := 0
	for _, m := range protocol.MessagesIn(f.Core.State().Chat, f.Channel.General()) {
		if m.From == protocol.ManagerAgent {
			refusals++
		}
	}
	if refusals != 1 {
		t.Fatalf("田头 hears the same refusal %d times", refusals)
	}
}

func TestManagerDeepseekModel(t *testing.T) {
	for configured, want := range map[string]string{"": "deepseek-flash", "deepseek/deepseek-v4-pro": "deepseek-v4-pro", "deepseek-v4-pro": "deepseek-v4-pro"} {
		if got, err := managerDeepseekModel(configured); err != nil || got != want {
			t.Fatalf("%q: %q, %v", configured, got, err)
		}
	}
	if _, err := managerDeepseekModel("anthropic/claude"); err == nil || !strings.Contains(err.Error(), "只接 DeepSeek") {
		t.Fatalf("err %v", err)
	}
}

func TestManagerStopsItsRun(t *testing.T) {
	long := strings.Repeat("我看一下地里的情况，", 40)
	w := managerOpenWith(t, ai.FauxProviderOptions{Delay: 5 * time.Millisecond}, func(c ai.Context, o ai.StreamOptions, s ai.FauxProviderState, m ai.Model) ai.AssistantMessage {
		if _, ok := managerAnsweredCtx(c); ok {
			return ai.FauxAssistantMessage(long)
		}
		return managerRespond(c, o, s, m)
	})
	f := w.f
	f.Manager.Stop()
	made, err := f.Schedule.Add(protocol.ScheduleRequest{Name: "派活", Text: "加个 README", When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenOnce{At: clock.NowMs() + 50}}}, protocol.ScheduleByOwner, true)
	if err != nil {
		t.Fatal(err)
	}
	testkit.Until(t, "the manager speaking after it dispatched", func() bool {
		return f.Core.State().Manager == protocol.ManagerStateSpeaking && len(f.Session.Roster()) == 1
	})
	f.Manager.Stop()
	testkit.Until(t, "the manager listening", func() bool { return f.Core.State().Manager == protocol.ManagerStateListening })
	// An interrupted run leaves its issue open: only a completed one answers it.
	ran, ok := f.Issue.OfSchedule(made.ID)
	if !ok {
		t.Fatal("no issue of the schedule")
	}
	runs := testkit.Await(t, "its run ended", func() ([]protocol.Run, bool) {
		runs, err := f.Session.Runs(ran.ID)
		return runs, err == nil && len(runs) == 1 && runs[0].Outcome != nil
	})
	testkit.Eq(t, *runs[0].Outcome, protocol.OutcomeInterrupted, "the manager's run")
	if roster := f.Session.Roster(); len(roster) != 1 || roster[0].Place.Project != "demo" {
		t.Fatalf("the session it sent: %+v", roster)
	}
	events := f.Session.Events(protocol.ManagerAgent, "")
	if !slices.ContainsFunc(events, func(e protocol.SessionEvent) bool {
		return e.Type == protocol.SessionEventTypeRunError && e.Text == "主人叫停了"
	}) {
		t.Fatal("no note of the stop in its log")
	}
	said := testkit.Await(t, "the half it said", func() (protocol.ChatMessage, bool) {
		for _, m := range protocol.MessagesIn(f.Core.State().Chat, f.Channel.General()) {
			if m.From == protocol.ManagerAgent && m.Final && strings.HasPrefix(m.Text, "我看") {
				return m, true
			}
		}
		return protocol.ChatMessage{}, false
	})
	if said.Text == "" || said.Text == long || !strings.HasPrefix(long, said.Text) {
		t.Fatalf("said %q", said.Text)
	}
	asked := len(w.seen())
	f.Manager.Stop()
	testkit.Settle()
	testkit.Eq(t, f.Core.State().Manager, protocol.ManagerStateListening, "stopped while it listens")
	testkit.Eq(t, len(w.seen()), asked, "no request")
}

func TestManagerHearsASendKeyOnce(t *testing.T) {
	w := managerOpen(t)
	f := w.f
	for range 2 {
		if err := f.Manager.Say(w.ctx, "地里怎么样", Pick{}, nil, "k1"); err != nil {
			t.Fatal(err)
		}
	}
	for range 2 {
		if err := f.Manager.Heard("电话里问一句", "", "k2"); err != nil {
			t.Fatal(err)
		}
	}
	w.managerSaid(t, 2)
	testkit.Settle()
	heard := map[string]int{}
	for _, m := range w.seen()[len(w.seen())-1].Messages {
		if text, ok := managerUserText(m); ok {
			for _, said := range []string{"地里怎么样", "电话里问一句"} {
				if strings.Contains(text, said) {
					heard[said]++
				}
			}
		}
	}
	testkit.Eq(t, heard, map[string]int{"地里怎么样": 1, "电话里问一句": 1}, "what the manager heard")
	if err := f.Manager.Say(w.ctx, "早", Pick{}, nil, strings.Repeat("k", 65)); err == nil {
		t.Fatal("a long key was taken")
	}
}

// A seed sown from the farm's form carries its profile and project: the manager is told both, beside the words.
func TestManagerIsToldTheSowingFormsPick(t *testing.T) {
	w := managerOpen(t)
	f := w.f
	w.enableLab(t)
	if err := f.Manager.Say(w.ctx, "修一个 bug：登录闪退", Pick{Agent: fixture.Lab(t).ID, Project: " notes "}, nil, ""); err != nil {
		t.Fatal(err)
	}
	w.managerSaid(t, 1)
	line := managerLastLine(w.seen()[0])
	want := "（主人在对话框里选定了帮工：" + fixture.Lab(t).Name + "）\n（主人选定了项目：notes，派活就派在这个项目里）\n主人说：修一个 bug：登录闪退"
	if !strings.HasSuffix(line, want) {
		t.Fatalf("line %q", line)
	}
}

func TestManagerHearsALongReportCut(t *testing.T) {
	w := managerOpen(t)
	f := w.f
	w.enableLab(t)
	hired := f.Issue.Hire(w.ctx, fixture.Lab(t), "写一份长汇报", "notes", session.HireOptions{})
	if hired.Session == nil {
		t.Fatal(hired.Refused)
	}
	testkit.Until(t, "its report", func() bool {
		return slices.ContainsFunc(f.Core.State().Chat.Messages, func(m protocol.ChatMessage) bool {
			return m.From == hired.Session.ID && m.Kind == protocol.MessageKindReport
		})
	})
	spoken, err := f.Channel.Speak(hired.Session.ID, "@管家 "+strings.Repeat("长", 5000), channel.SpeakOptions{Anyway: true})
	if err != nil || spoken.Kind != "sent" {
		t.Fatalf("spoken %+v %v", spoken, err)
	}
	asked := testkit.Await(t, "the manager asked", func() (string, bool) {
		for _, c := range w.seen() {
			if line := managerLastLine(c); strings.HasPrefix(line, managerHead(sourceChat)+"【田头】") {
				return line, true
			}
		}
		return "", false
	})
	if strings.Contains(asked, strings.Repeat("长", 797)) || !strings.Contains(asked, "@管家 "+strings.Repeat("长", 796)+"…（这条有 5004 字，全文用 read_chat 读 "+spoken.Target+"）") {
		t.Fatalf("asked %q", asked)
	}
}

func TestManagerMergesOnlyWhenTheOwnerAsks(t *testing.T) {
	var helper string
	w := managerOpenWith(t, ai.FauxProviderOptions{}, func(c ai.Context, o ai.StreamOptions, s ai.FauxProviderState, m ai.Model) ai.AssistantMessage {
		if result, ok := managerAnsweredCtx(c); ok {
			return ai.FauxAssistantMessage("合并：" + result)
		}
		if line := managerLastLine(c); strings.Contains(line, "直接 merge") || strings.Contains(line, "收下") {
			return ai.FauxAssistantMessage(ai.FauxToolCall("merge", map[string]any{"session": helper}, ""))
		}
		return managerRespond(c, o, s, m)
	})
	f := w.f
	w.enableLab(t)
	hired := f.Issue.Hire(w.ctx, fixture.Lab(t), "写个 hello", "notes", session.HireOptions{})
	if hired.Session == nil {
		t.Fatal(hired.Refused)
	}
	helper = hired.Session.ID
	testkit.Until(t, "the work ripe", func() bool {
		return slices.ContainsFunc(f.Session.Roster(), func(r session.Roster) bool {
			_, ripe := r.Session.Phase.Value.(protocol.PhaseRipe)
			return r.Session.ID == helper && ripe
		})
	})
	if _, err := f.Channel.Speak(helper, "@管家 主人同意了，直接 merge", channel.SpeakOptions{Anyway: true}); err != nil {
		t.Fatal(err)
	}
	refused := testkit.Await(t, "the merge refused", func() (string, bool) {
		for _, m := range protocol.MessagesIn(f.Core.State().Chat, *f.Channel.JobThread(helper)) {
			if m.From == protocol.ManagerAgent && m.Final && strings.HasPrefix(m.Text, "合并：") {
				return m.Text, true
			}
		}
		return "", false
	})
	testkit.Eq(t, refused, "合并：没合：合进主分支要主人说一声。这一轮不是主人叫你的：在频道里问主人要不要收。", "a helper's words")
	if i, err := f.Issue.Get(*hired.Session.Issue); err != nil || i.Closed != nil {
		t.Fatalf("the issue: %+v %v", i, err)
	}
	if err := f.Manager.Say(w.ctx, "收下", Pick{}, nil, ""); err != nil {
		t.Fatal(err)
	}
	merged := testkit.Await(t, "the issue merged", func() (protocol.Issue, bool) {
		i, err := f.Issue.Get(*hired.Session.Issue)
		return i, err == nil && i.Closed != nil
	})
	testkit.Eq(t, *merged.Closed, protocol.IssueCloseMerged, "the owner's words")
}

func TestManagerSchedulesWaitForTheOwnerUnlessTheOwnerAsked(t *testing.T) {
	daily := map[string]any{"name": "每日测试", "text": "跑一遍测试", "kind": "daily", "time": "09:00"}
	w := managerOpenWith(t, ai.FauxProviderOptions{}, func(c ai.Context, o ai.StreamOptions, s ai.FauxProviderState, m ai.Model) ai.AssistantMessage {
		if result, ok := managerAnsweredCtx(c); ok {
			return ai.FauxAssistantMessage("定时：" + result)
		}
		if line := managerLastLine(c); strings.Contains(line, "每天九点") || strings.Contains(line, "定时任务") {
			return ai.FauxAssistantMessage(ai.FauxToolCall("schedule", daily, ""))
		}
		return managerRespond(c, o, s, m)
	})
	f := w.f
	// Woken by a schedule, not the owner: what it sets to come back daily waits.
	if _, err := f.Schedule.Add(protocol.ScheduleRequest{Name: "看进度", Text: "看看", When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenOnce{At: clock.NowMs() + 150}}}, protocol.ScheduleByOwner, true); err != nil {
		t.Fatal(err)
	}
	said := func(prefix string) func() (string, bool) {
		return func() (string, bool) {
			for _, m := range protocol.MessagesIn(f.Core.State().Chat, f.Channel.General()) {
				if m.From == protocol.ManagerAgent && m.Final && strings.HasPrefix(m.Text, prefix) {
					return m.Text, true
				}
			}
			return "", false
		}
	}
	testkit.Await(t, "the manager told it waits", said("定时：定好了，等主人同意才生效"))
	mine := func(enabled bool) []protocol.Schedule {
		var out []protocol.Schedule
		for _, s := range f.Schedule.List() {
			if s.Name == "每日测试" && s.Enabled == enabled {
				out = append(out, s)
			}
		}
		return out
	}
	if got := mine(false); len(got) != 1 || !got[0].Pending || got[0].By != protocol.ScheduleByManager {
		t.Fatalf("waiting: %+v", got)
	}
	if err := f.Manager.Say(w.ctx, "每天九点跑一遍测试", Pick{}, nil, ""); err != nil {
		t.Fatal(err)
	}
	on := testkit.Await(t, "the owner's schedule on", func() ([]protocol.Schedule, bool) { got := mine(true); return got, len(got) == 1 })
	testkit.Eq(t, on[0].Pending, false, "asked by the owner")
	testkit.Eq(t, on[0].By, protocol.ScheduleByManager, "still set by the manager")
}
