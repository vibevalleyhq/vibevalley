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

	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/agent"
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

func managerLastLine(c ai.Context) string {
	for i := len(c.Messages) - 1; i >= 0; i-- {
		if text, ok := managerUserText(c.Messages[i]); ok {
			return text
		}
	}
	return ""
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
		args := map[string]any{"task": asked, "project": "demo"}
		if strings.Contains(asked, "CHANGELOG") {
			args = map[string]any{"task": asked, "project": "notes", "agent": "lab"}
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
	cfg := fixture.Config(t.TempDir(), t.TempDir(), ":memory:")
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
	f.Runtime.Registry = registry
	f.Runtime.Probe = func(_ context.Context, id string) protocol.RuntimeInfo {
		if id != "pi" {
			return protocol.RuntimeInfo{ID: id, Installation: protocol.Installation{Value: protocol.InstallationNotFound{}}, Settings: f.Agent.Settings(id)}
		}
		return fixture.Pi()
	}
	w.faux = ai.FauxProvider(ai.FauxProviderOptions{})
	steps := make([]ai.FauxResponseStep, 100)
	for i := range steps {
		steps[i] = ai.FauxResponseFactory(managerRespond)
	}
	w.faux.SetResponses(steps...)
	f.Manager.llm = &agent.LLM{Model: w.faux.GetModel()}
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

func TestManagerDispatchesAndHearsVoiceInSilence(t *testing.T) {
	w := managerOpen(t)
	f := w.f
	w.enableLab(t)
	if err := f.Manager.Say(w.ctx, "帮我在 demo 里加个 README", "", nil); err != nil {
		t.Fatal(err)
	}
	if said := w.managerSaid(t, 1); !slices.Equal(said, []string{"好，已在了"}) {
		t.Fatalf("said %q", said)
	}
	first := w.seen()[0]
	if !regexp.MustCompile(`【农场现状】[\s\S]*可以派的帮工：\n- `).MatchString(first.SystemPrompt) {
		t.Fatalf("system prompt: %s", first.SystemPrompt)
	}
	if line := managerLastLine(first); line != "主人说：帮我在 demo 里加个 README" {
		t.Fatalf("line %q", line)
	}
	trail := testkit.Await(t, "its trajectory", func() (*protocol.Trajectory, bool) {
		tr := f.Session.Get(protocol.ManagerAgent)
		return tr, tr != nil && len(tr.Activities) >= 3 && tr.Activities[len(tr.Activities)-1].Kind == protocol.ActivityKindResponse
	})
	if trail.Head.Name != "管家" {
		t.Fatalf("head %+v", trail.Head)
	}
	last := trail.Activities[len(trail.Activities)-3:]
	asked, tool, answer := last[0], last[1], last[2]
	if asked.Kind != protocol.ActivityKindPrompt || !strings.Contains(asked.Text, "加个 README") {
		t.Fatalf("asked %+v", asked)
	}
	if tool.Tool == nil || *tool.Tool != "dispatch" || tool.Text != "派活：demo" || tool.Ok == nil || !*tool.Ok ||
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
	f.Manager.Heard("随便说一句", "")
	testkit.Until(t, "the manager asked", func() bool { return len(w.seen()) > before })
	testkit.Settle()
	if said := w.managerSaid(t, 1); !slices.Equal(said, []string{"好，已在了"}) {
		t.Fatalf("heard by voice, it said %q", said)
	}
	if line := managerLastLine(w.seen()[len(w.seen())-1]); !strings.Contains(line, "语音那边已经回答了") {
		t.Fatalf("line %q", line)
	}
	kept, err := os.ReadFile(filepath.Join(f.Home, protocol.ManagerAgent, "manager.jsonl"))
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`"customType":"farmNews"[^\n]*做完了`).Match(kept) {
		t.Fatalf("no farm news kept:\n%s", kept)
	}
	if strings.Contains(string(kept), "【农场现状】") {
		t.Fatal("the situation was kept in the conversation")
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
	if _, err := f.Setting.Save(protocol.SettingsUpdate{Voice: &protocol.SettingsUpdateVoice{LLM: protocol.VoiceLLM{Value: protocol.VoiceLLMVibeValley{}}}}); err != nil {
		t.Fatal(err)
	}
	f.Manager.Heard("随便说一句", "")
	testkit.Settle()
	if len(w.seen()) != before+1 {
		t.Fatal("the relay reached the manager")
	}
}

func TestManagerSchedulesComeDue(t *testing.T) {
	w := managerOpen(t)
	f := w.f
	made, err := f.Schedule.Add(protocol.ScheduleRequest{Name: "看进度", Text: "看看帮工们的进度", When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenOnce{At: clock.NowMs() + 150}}})
	if err != nil {
		t.Fatal(err)
	}
	if made.Channel != f.Channel.General() {
		t.Fatalf("channel %d", made.Channel)
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
	if c := w.seen()[woke]; !regexp.MustCompile(`^【定时任务「看进度」到点了】\n看看帮工们的进度\n\n这是 #田头 的定时`).MatchString(managerLastLine(c)) ||
		!strings.Contains(c.SystemPrompt, "【农场现状】") {
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
	if _, err := f.Schedule.Add(protocol.ScheduleRequest{Name: "巡检", Text: "跑一遍检查", Channel: &ops.ID, Agent: &lab, When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenOnce{At: clock.NowMs() + 150}}}); err != nil {
		t.Fatal(err)
	}
	sent := testkit.Await(t, "the session sent", func() (session.Roster, bool) {
		for _, r := range f.Session.Roster() {
			if r.Session.Task == "巡检\n\n跑一遍检查" {
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
	_, err = f.Schedule.Add(protocol.ScheduleRequest{Name: "x", Text: "y", Channel: &general, Agent: &lab, When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenEvery{Minutes: 5}}})
	if err == nil || !strings.Contains(err.Error(), "默认项目") {
		t.Fatalf("err %v", err)
	}
}

func TestManagerHearsThePatrol(t *testing.T) {
	w := managerOpen(t)
	f := w.f
	w.enableLab(t)
	if err := f.Manager.Say(w.ctx, "帮我在 notes 里加个 CHANGELOG", "", nil); err != nil {
		t.Fatal(err)
	}
	testkit.Until(t, "the work ripe", func() bool {
		return slices.ContainsFunc(f.Session.Roster(), func(r session.Roster) bool {
			_, ripe := r.Session.Phase.Value.(protocol.PhaseRipe)
			return r.Session.Task == "加个 CHANGELOG" && ripe
		})
	})
	hoursOn := func(h float64) func() int64 {
		return func() int64 { return clock.NowMs() + int64(h*3_600_000) }
	}
	patrol := regexp.MustCompile(`^【巡查】[\s\S]*「加个 CHANGELOG」`)
	ours := func(c ai.Context) bool { return patrol.MatchString(managerLastLine(c)) }
	f.Manager.Patrol()
	testkit.Settle()
	if slices.ContainsFunc(w.seen(), func(c ai.Context) bool { return strings.HasPrefix(managerLastLine(c), "【巡查】") }) {
		t.Fatal("not yet past its grace")
	}
	f.Manager.PatrolNow = hoursOn(3)
	f.Manager.Patrol()
	testkit.Until(t, "the patrol's news", func() bool { return slices.ContainsFunc(w.seen(), ours) })
	line := managerLastLine(w.seen()[slices.IndexFunc(w.seen(), ours)])
	if !regexp.MustCompile(`^【巡查】#田头 里有几件事放着没人管：\n(- .+\n)*- .+（w\d+）的活做完 3 小时了还没收：「加个 CHANGELOG」`).MatchString(line) {
		t.Fatalf("patrol %q", line)
	}
	// Each request carries the whole conversation: count this work's patrol lines in the latest.
	f.Manager.PatrolNow = hoursOn(3.5)
	f.Manager.Patrol()
	testkit.Settle()
	latest := w.seen()[len(w.seen())-1]
	n := 0
	for _, m := range latest.Messages {
		if text, ok := managerUserText(m); ok && patrol.MatchString(text) {
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

func TestManagerToolStart(t *testing.T) {
	start := managerToolStart("dispatch", []byte(`{ "task": "加个 README", "project": "demo" }`))
	if start.Text != "派活：demo" || start.Input != `{"task":"加个 README","project":"demo"}` || start.Action != protocol.ToolActionOther {
		t.Fatalf("%+v", start)
	}
	long := managerToolStart("plan", []byte(`{"goal":"`+strings.Repeat("长", 50)+`"}`))
	if long.Text != "拆计划："+strings.Repeat("长", 40)+"…" {
		t.Fatalf("%q", long.Text)
	}
	if managerToolStart("unknown", nil).Text != "unknown" {
		t.Fatal("an unknown tool is named by its name")
	}
}
