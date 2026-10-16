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

	"vibevalley/internal/base"
	"vibevalley/internal/farmtest"
	"vibevalley/internal/memory"
	"vibevalley/internal/protocol"
	"vibevalley/pkg/agent"
	"vibevalley/pkg/ai"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
)

// The manager on vibevalley's own agent (foreman.test.ts), with the real farm (chat, crew, SQLite), pi played by smith's
// scripted runtime, and a scripted model through ai.FauxProvider: told something on 田头, it is given the farm's
// situation, dispatches a helper with its tool and says so on 田头; a line heard by voice is acted on in silence; a
// helper's report waits and comes in as farm news; a call's words stream back; a schedule that comes due is said in
// its channel and wakes it, or sends its helper straight off; the heartbeat's findings wake it once. The situation is
// in the system prompt, never in the saved conversation. Offline.

type foremanWorld struct {
	f    *world
	faux *ai.FauxProviderHandle
	ctx  context.Context

	mu sync.Mutex
	// tokens: the bearer token each helper session was handed for the farm's MCP server, by its folder.
	tokens map[string]string
}

// foremanUserText is the words of a user's message (the person's, or the farm's news) as the model got them.
func foremanUserText(m ai.Message) (string, bool) {
	u, ok := m.(ai.UserMessage)
	if !ok {
		return "", false
	}
	return u.Content.Words("\n"), true
}

// foremanLastLine is the last thing said to the model in a request: the line the manager is answering.
func foremanLastLine(c ai.Context) string {
	for i := len(c.Messages) - 1; i >= 0; i-- {
		if text, ok := foremanUserText(c.Messages[i]); ok {
			return text
		}
	}
	return ""
}

func foremanAnsweredCtx(c ai.Context) (string, bool) {
	if len(c.Messages) == 0 {
		return "", false
	}
	if r, ok := c.Messages[len(c.Messages)-1].(ai.ToolResultMessage); ok {
		return ai.ContentText(r.Content, "\n"), true
	}
	return "", false
}

// foremanSinceAnswer is everything said to the model since it last spoke: the line, and farm news that came with it.
func foremanSinceAnswer(c ai.Context) string {
	from := 0
	for i, m := range c.Messages {
		if m.Role() == "assistant" {
			from = i + 1
		}
	}
	var said []string
	for _, m := range c.Messages[from:] {
		if text, ok := foremanUserText(m); ok {
			said = append(said, text)
		}
	}
	return strings.Join(said, "\n")
}

var foremanAsked = regexp.MustCompile(`(?m)加个 (README|CHANGELOG)$`)

// foremanRespond is the manager's model: dispatches when asked to, says what came back, answers anything else in a word.
func foremanRespond(c ai.Context, _ ai.StreamOptions, _ ai.FauxProviderState, _ ai.Model) ai.AssistantMessage {
	if result, ok := foremanAnsweredCtx(c); ok {
		return ai.FauxAssistantMessage("好，" + base.Head(result, 2) + "了")
	}
	if asked := foremanAsked.FindString(foremanSinceAnswer(c)); asked != "" {
		args := map[string]any{"task": asked, "project": "demo"}
		if strings.Contains(asked, "CHANGELOG") {
			args = map[string]any{"task": asked, "project": "notes", "agent": "lab"}
		}
		return ai.FauxAssistantMessage(ai.FauxToolCall("dispatch", args, ""))
	}
	if strings.Contains(foremanLastLine(c), "定时任务") {
		return ai.FauxAssistantMessage("到点了，看了一眼")
	}
	return ai.FauxAssistantMessage("收到")
}

// foremanOpen is a started farm whose manager talks to the scripted model and whose pi helpers are scripted.
func foremanOpen(t *testing.T) *foremanWorld {
	t.Helper()
	t.Setenv("VIBEVALLEY_SCHEDULE_TICK_MS", "50")
	// Rounds are run by hand here.
	t.Setenv("VIBEVALLEY_HEARTBEAT_MINUTES", "0")
	t.Setenv("VIBEVALLEY_FOREMAN_RUNTIME", "")
	t.Setenv("VIBEVALLEY_FOREMAN_MODEL", "")
	f, err := newWorld(base.Config{Home: t.TempDir(), WorkRoot: t.TempDir(), DBPath: ":memory:"})
	if err != nil {
		t.Fatal(err)
	}
	w := &foremanWorld{f: f, tokens: map[string]string{}}
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
	f.Runtimes.Registry = registry
	f.Runtimes.Probe = func(_ context.Context, id string) protocol.RuntimeInfo {
		if id != "pi" {
			return protocol.RuntimeInfo{ID: id, Installation: protocol.Installation{Value: protocol.InstallationNotFound{}}, Settings: f.Store.Settings(id)}
		}
		return farmtest.PiInfo()
	}
	w.faux = ai.FauxProvider(ai.FauxProviderOptions{})
	steps := make([]ai.FauxResponseStep, 100)
	for i := range steps {
		steps[i] = ai.FauxResponseFactory(foremanRespond)
	}
	w.faux.SetResponses(steps...)
	f.Foreman.llm = &agent.LLM{Model: w.faux.GetModel()}
	w.ctx = ai.WithProviders(context.Background(), w.faux.Provider)
	if err := f.Start(w.ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	return w
}

func (w *foremanWorld) seen() []ai.Context { return w.faux.State().Contexts }

// managerSaid is the manager's finished words on 田头, once there are count of them.
func (w *foremanWorld) managerSaid(t *testing.T, count int) []string {
	t.Helper()
	return farmtest.Await(t, "the manager's words", func() ([]string, bool) {
		var said []string
		for _, m := range protocol.MessagesIn(w.f.Site.State().Chat, w.f.Chat.Square()) {
			if m.From == "foreman" && m.Kind == protocol.MessageKindChat && m.Final {
				said = append(said, m.Text)
			}
		}
		return said, len(said) >= count
	})
}

func (w *foremanWorld) enableLab(t *testing.T) {
	t.Helper()
	lab := farmtest.Lab(t)
	lab.Enabled = true
	if _, err := w.f.Store.SaveAgent(lab); err != nil {
		t.Fatal(err)
	}
}

func TestForemanDispatchesAndHearsVoiceInSilence(t *testing.T) {
	w := foremanOpen(t)
	f := w.f
	w.enableLab(t)
	if err := f.Foreman.Say(w.ctx, "帮我在 demo 里加个 README", "", nil); err != nil {
		t.Fatal(err)
	}
	if said := w.managerSaid(t, 1); !slices.Equal(said, []string{"好，已在了"}) {
		t.Fatalf("said %q", said)
	}
	first := w.seen()[0]
	// The farm's situation is in the system prompt; the line is the line.
	if !regexp.MustCompile(`【农场现状】[\s\S]*可以派的帮工：\n- `).MatchString(first.SystemPrompt) {
		t.Fatalf("system prompt: %s", first.SystemPrompt)
	}
	if line := foremanLastLine(first); line != "主人说：帮我在 demo 里加个 README" {
		t.Fatalf("line %q", line)
	}
	// Its trajectory: the line, the tool it called with what came back, what it said.
	trail := farmtest.Await(t, "its trajectory", func() (*protocol.Trajectory, bool) {
		tr := f.Trajectories.Get(memory.ManagerAgent)
		return tr, tr != nil && len(tr.Steps) >= 3 && tr.Steps[len(tr.Steps)-1].Kind == protocol.StepKindSaid
	})
	if trail.Head.Name != "管家" {
		t.Fatalf("head %+v", trail.Head)
	}
	last := trail.Steps[len(trail.Steps)-3:]
	asked, tool, answer := last[0], last[1], last[2]
	if asked.Kind != protocol.StepKindAsked || !strings.Contains(asked.Text, "加个 README") {
		t.Fatalf("asked %+v", asked)
	}
	if tool.Tool == nil || *tool.Tool != "dispatch" || tool.Text != "派活：demo" || tool.Ok == nil || !*tool.Ok ||
		tool.Input == nil || !strings.Contains(*tool.Input, `"project":"demo"`) {
		t.Fatalf("tool %+v", tool)
	}
	if answer.Text != "好，已在了" {
		t.Fatalf("answer %+v", answer)
	}
	roster := f.Crew.Roster()
	if len(roster) != 1 || roster[0].Place.Project != "demo" {
		t.Fatalf("roster %+v", roster)
	}
	// The helper's report does not wake the manager: it waits, and comes with the next line as farm news.
	farmtest.Await(t, "its report", func() (bool, bool) {
		all := f.Crew.Roster()
		return true, len(all) == 1 && all[0].Helper.Last != nil
	})

	before := len(w.seen())
	f.Foreman.Heard("随便说一句", "")
	farmtest.Await(t, "the manager asked", func() (bool, bool) { return true, len(w.seen()) > before })
	time.Sleep(100 * time.Millisecond)
	if said := w.managerSaid(t, 1); !slices.Equal(said, []string{"好，已在了"}) {
		t.Fatalf("heard by voice, it said %q", said)
	}
	if line := foremanLastLine(w.seen()[len(w.seen())-1]); !strings.Contains(line, "语音那边已经回答了") {
		t.Fatalf("line %q", line)
	}
	kept, err := os.ReadFile(filepath.Join(f.Home, "foreman", "manager.jsonl"))
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

func TestForemanCallStreamsItsWords(t *testing.T) {
	w := foremanOpen(t)
	f := w.f
	before := len(w.seen())
	var words strings.Builder
	for piece := range f.Foreman.Call(w.ctx, "现在地里怎么样") {
		words.WriteString(piece)
	}
	if words.String() != "收到\n" {
		t.Fatalf("words %q", words.String())
	}
	seen := w.seen()
	if !regexp.MustCompile(`主人在电话里说的[\s\S]*主人说：现在地里怎么样`).MatchString(foremanLastLine(seen[len(seen)-1])) || len(seen) != before+1 {
		t.Fatalf("asked %d times; last %q", len(seen)-before, foremanLastLine(seen[len(seen)-1]))
	}
	// Answering calls itself, the manager does not also take the hosted voice's relay of the same words.
	if _, err := f.Settings.Save(protocol.SettingsUpdate{Voice: &protocol.SettingsUpdateVoice{LLM: protocol.VoiceLLM{Value: protocol.VoiceLLMVibeValley{}}}}); err != nil {
		t.Fatal(err)
	}
	f.Foreman.Heard("随便说一句", "")
	time.Sleep(200 * time.Millisecond)
	if len(w.seen()) != before+1 {
		t.Fatal("the relay reached the manager")
	}
}

func TestForemanSchedulesComeDue(t *testing.T) {
	w := foremanOpen(t)
	f := w.f
	made, err := f.Schedules.Add(protocol.ScheduleRequest{Name: "看进度", Text: "看看帮工们的进度", When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenOnce{At: base.NowMs() + 150}}})
	if err != nil {
		t.Fatal(err)
	}
	if made.Channel != f.Chat.Square() {
		t.Fatalf("channel %d", made.Channel)
	}
	if said := w.managerSaid(t, 1); !slices.Equal(said, []string{"到点了，看了一眼"}) {
		t.Fatalf("said %q", said)
	}
	i := slices.IndexFunc(protocol.MessagesIn(f.Site.State().Chat, f.Chat.Square()), func(m protocol.ChatMessage) bool { return m.Kind == protocol.MessageKindNotice })
	if i < 0 || protocol.MessagesIn(f.Site.State().Chat, f.Chat.Square())[i].Text != "⏰ 定时「看进度」到点了：看看帮工们的进度" {
		t.Fatal("no notice of it")
	}
	woke := slices.IndexFunc(w.seen(), func(c ai.Context) bool { return strings.Contains(foremanLastLine(c), "定时任务") })
	if woke < 0 {
		t.Fatal("never woken")
	}
	if c := w.seen()[woke]; !regexp.MustCompile(`^【定时任务「看进度」到点了】\n看看帮工们的进度\n\n这是 #田头 的定时`).MatchString(foremanLastLine(c)) ||
		!strings.Contains(c.SystemPrompt, "【农场现状】") {
		t.Fatalf("woken with %q", foremanLastLine(c))
	}
	// A once is done after it ran.
	if i := slices.IndexFunc(f.Schedules.List(), func(s protocol.FarmSchedule) bool { return s.ID == made.ID }); i < 0 || f.Schedules.List()[i].Enabled {
		t.Fatal("still enabled")
	}

	// Naming a helper: a recurring issue. An issue is written from it and started, in the schedule's channel, without
	// the manager.
	w.enableLab(t)
	asked := len(w.seen())
	ops, err := f.Chat.OpenChannel("ops", "", "demo")
	if err != nil {
		t.Fatal(err)
	}
	lab := "lab"
	if _, err := f.Schedules.Add(protocol.ScheduleRequest{Name: "巡检", Text: "跑一遍检查", Channel: &ops.ID, Agent: &lab, When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenOnce{At: base.NowMs() + 150}}}); err != nil {
		t.Fatal(err)
	}
	sent := farmtest.Await(t, "the helper sent", func() (base.Roster, bool) {
		for _, r := range f.Crew.Roster() {
			if r.Helper.Task == "巡检\n\n跑一遍检查" {
				return r, true
			}
		}
		return base.Roster{}, false
	})
	if sent.Helper.Channel == nil || *sent.Helper.Channel != ops.ID || sent.Place.Project != "demo" {
		t.Fatalf("sent %+v", sent)
	}
	if issue, err := f.Issues.Get(sent.Helper.ID); err != nil || issue.Schedule == nil || issue.Title != "巡检" {
		t.Fatalf("its issue: %+v %v", issue, err)
	}
	if len(w.seen()) != asked {
		t.Fatal("the manager was asked")
	}
	square := f.Chat.Square()
	_, err = f.Schedules.Add(protocol.ScheduleRequest{Name: "x", Text: "y", Channel: &square, Agent: &lab, When: protocol.ScheduleWhen{Value: protocol.ScheduleWhenEvery{Minutes: 5}}})
	if err == nil || !strings.Contains(err.Error(), "默认项目") {
		t.Fatalf("err %v", err)
	}
}

func TestForemanHeartbeatWakesItOnce(t *testing.T) {
	w := foremanOpen(t)
	f := w.f
	w.enableLab(t)
	// Work done and left: the helper from a dispatch, three hours on.
	if err := f.Foreman.Say(w.ctx, "帮我在 notes 里加个 CHANGELOG", "", nil); err != nil {
		t.Fatal(err)
	}
	farmtest.Await(t, "the work ripe", func() (bool, bool) {
		return true, slices.ContainsFunc(f.Crew.Roster(), func(r base.Roster) bool {
			_, ripe := r.Helper.Phase.Value.(protocol.PhaseRipe)
			return r.Helper.Task == "加个 CHANGELOG" && ripe
		})
	})
	hoursOn := func(h float64) func() int64 {
		return func() int64 { return base.NowMs() + int64(h*3_600_000) }
	}
	patrol := regexp.MustCompile(`^【巡查】[\s\S]*「加个 CHANGELOG」`)
	ours := func(c ai.Context) bool { return patrol.MatchString(foremanLastLine(c)) }
	f.Heartbeat.Round()
	time.Sleep(100 * time.Millisecond)
	if slices.ContainsFunc(w.seen(), func(c ai.Context) bool { return strings.HasPrefix(foremanLastLine(c), "【巡查】") }) {
		t.Fatal("not yet past its grace")
	}
	f.Heartbeat.Now = hoursOn(3)
	f.Heartbeat.Round()
	farmtest.Await(t, "the patrol's news", func() (bool, bool) { return true, slices.ContainsFunc(w.seen(), ours) })
	line := foremanLastLine(w.seen()[slices.IndexFunc(w.seen(), ours)])
	if !regexp.MustCompile(`^【巡查】#田头 里有几件事放着没人管：\n(- .+\n)*- .+（w\d+）的活做完 3 小时了还没收：「加个 CHANGELOG」`).MatchString(line) {
		t.Fatalf("patrol %q", line)
	}
	// Each request carries the whole conversation: count this work's patrol lines in the latest.
	f.Heartbeat.Now = hoursOn(3.5)
	f.Heartbeat.Round()
	time.Sleep(300 * time.Millisecond)
	latest := w.seen()[len(w.seen())-1]
	n := 0
	for _, m := range latest.Messages {
		if text, ok := foremanUserText(m); ok && patrol.MatchString(text) {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("reported %d times", n)
	}
}

func TestForemanTellsItsStartFailure(t *testing.T) {
	t.Setenv("VIBEVALLEY_FOREMAN_RUNTIME", "pi")
	f, err := newWorld(base.Config{Home: t.TempDir(), WorkRoot: t.TempDir(), DBPath: ":memory:"})
	if err != nil {
		t.Fatal(err)
	}
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(f.Close)
	var words []string
	for piece := range f.Foreman.Call(context.Background(), "在吗") {
		words = append(words, piece)
	}
	if len(words) != 1 || !strings.Contains(words[0], "VIBEVALLEY_FOREMAN_RUNTIME=pi") {
		t.Fatalf("words %q", words)
	}
	said := farmtest.Await(t, "the refusal on 田头", func() (string, bool) {
		for _, m := range protocol.MessagesIn(f.Site.State().Chat, f.Chat.Square()) {
			if m.From == "foreman" {
				return m.Text, true
			}
		}
		return "", false
	})
	if !strings.HasPrefix(said, "我这边起不来：") {
		t.Fatalf("said %q", said)
	}
}

func TestForemanDeepseekModel(t *testing.T) {
	for configured, want := range map[string]string{"": "deepseek-flash", "deepseek/deepseek-v4-pro": "deepseek-v4-pro", "deepseek-v4-pro": "deepseek-v4-pro"} {
		if got, err := foremanDeepseekModel(configured); err != nil || got != want {
			t.Fatalf("%q: %q, %v", configured, got, err)
		}
	}
	if _, err := foremanDeepseekModel("anthropic/claude"); err == nil || !strings.Contains(err.Error(), "只接 DeepSeek") {
		t.Fatalf("err %v", err)
	}
}

func TestForemanToolStart(t *testing.T) {
	start := foremanToolStart("dispatch", []byte(`{ "task": "加个 README", "project": "demo" }`))
	if start.Text != "派活：demo" || start.Input != `{"task":"加个 README","project":"demo"}` || start.Action != protocol.ToolActionOther {
		t.Fatalf("%+v", start)
	}
	long := foremanToolStart("plan", []byte(`{"goal":"`+strings.Repeat("长", 50)+`"}`))
	if long.Text != "拆计划："+strings.Repeat("长", 40)+"…" {
		t.Fatalf("%q", long.Text)
	}
	if foremanToolStart("unknown", nil).Text != "unknown" {
		t.Fatal("an unknown tool is named by its name")
	}
}
