package channel

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/str"
)

type chatFakeSessions struct {
	f     *world
	hub   *base.Hub[session.LaunchActivity]
	slow  time.Duration
	stop  chan struct{}
	once  sync.Once
	close func()

	mu      sync.Mutex
	inputs  map[string][]string
	steers  map[string][]string
	last    map[string]string
	running map[string]string
	n       int
}

func (x *chatFakeSessions) Activity() *base.Hub[session.LaunchActivity] { return x.hub }

func (x *chatFakeSessions) Find(id string) *session.Roster {
	h := x.f.Core.Session(id)
	if h == nil {
		return nil
	}
	x.mu.Lock()
	defer x.mu.Unlock()
	return &session.Roster{Session: *h, LastText: x.last[id]}
}

func (x *chatFakeSessions) Deliver(id, text string, _ protocol.RunTrigger) session.Delivered {
	if x.f.Core.Session(id) == nil {
		return session.Delivered{Kind: "refused", Reason: "不在地里"}
	}
	x.mu.Lock()
	if launch, ok := x.running[id]; ok {
		x.steers[id] = append(x.steers[id], text)
		x.mu.Unlock()
		return session.Delivered{Kind: "steered", Launch: launch}
	}
	x.n++
	launch := fmt.Sprintf("%s-%d", id, x.n)
	x.running[id] = launch
	x.inputs[id] = append(x.inputs[id], text)
	x.mu.Unlock()
	x.f.Core.Apply(protocol.FactRun{ID: id})
	go x.run(id, launch, text)
	return session.Delivered{Kind: "run", Launch: launch, Woke: true}
}

func (x *chatFakeSessions) run(id, launch, input string) {
	if strings.Contains(input, "慢慢做") {
		select {
		case <-time.After(x.slow):
		case <-x.stop:
			return
		}
	}
	x.mu.Lock()
	runs := int64(len(x.inputs[id]))
	x.mu.Unlock()
	if strings.Contains(input, "必败") {
		x.mu.Lock()
		delete(x.running, id)
		x.mu.Unlock()
		x.f.Core.Apply(protocol.FactReport{ID: id, Outcome: protocol.OutcomeFailed, Summary: "provider said no", Runs: runs})
		x.hub.Publish(session.LaunchActivity{Kind: "ended", ID: id, Launch: launch, Outcome: protocol.OutcomeFailed})
		return
	}
	line := ""
	for _, l := range strings.Split(input, "\n") {
		if strings.HasPrefix(l, "[target=") {
			line = l
			break
		}
	}
	if line == "" {
		line = str.Head(input, 20)
	}
	x.mu.Lock()
	x.last[id] = "结论：收到了（" + line + "）"
	x.mu.Unlock()
	x.hub.Publish(session.LaunchActivity{Kind: "spoke", ID: id, Launch: launch})
	x.mu.Lock()
	delete(x.running, id)
	x.mu.Unlock()
	x.f.Core.Apply(protocol.FactReport{ID: id, Outcome: protocol.OutcomeCompleted, Summary: "收到了", Runs: runs})
	x.hub.Publish(session.LaunchActivity{Kind: "ended", ID: id, Launch: launch, Outcome: protocol.OutcomeCompleted, Spoke: true})
}

func (x *chatFakeSessions) runsOf(id string) []string {
	x.mu.Lock()
	defer x.mu.Unlock()
	return slices.Clone(x.inputs[id])
}

func (x *chatFakeSessions) steersOf(id string) []string {
	x.mu.Lock()
	defer x.mu.Unlock()
	return slices.Clone(x.steers[id])
}

// The conversation the service found, as the core state has it.
func chatConversation(f *world, id *int64) *protocol.Conversation {
	if id == nil {
		return nil
	}
	return protocol.ConversationOf(f.Core.State().Chat, *id)
}

func chatTestFarm(t *testing.T, home, dbPath string) (*world, *chatFakeSessions) {
	t.Helper()
	f, err := newWorld(fixture.Config(home, t.TempDir(), dbPath))
	if err != nil {
		t.Fatal(err)
	}
	x := &chatFakeSessions{
		f: f, hub: base.NewHub[session.LaunchActivity](), slow: 1500 * time.Millisecond, stop: make(chan struct{}),
		inputs: map[string][]string{}, steers: map[string][]string{}, last: map[string]string{}, running: map[string]string{},
	}
	f.Channel.sessions = x
	f.Channel.noticeEvery = 300 * time.Millisecond
	f.Channel.retryWake = 100 * time.Millisecond
	if err := f.Start(context.Background()); err != nil {
		t.Fatal(err)
	}
	x.close = func() {
		x.once.Do(func() {
			close(x.stop)
			f.Close()
		})
	}
	t.Cleanup(x.close)
	return f, x
}

func chatMessagesIn(f *world, conversation int64) []protocol.ChatMessage {
	chat := f.Core.State().Chat
	return protocol.MessagesIn(chat, conversation)
}

type chatTestDelivery struct {
	Seq    int64
	Reason string
	Wakes  bool
	HeldBy string
	State  string
}

func chatDeliveries(t *testing.T, f *world, recipient string) []chatTestDelivery {
	t.Helper()
	rows, err := f.DB.Query(`select message_seq, reason, wakes, coalesce(held_by, ''), state from channel_delivery where recipient_id = ? order by message_seq`, recipient)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var out []chatTestDelivery
	for rows.Next() {
		var d chatTestDelivery
		if err := rows.Scan(&d.Seq, &d.Reason, &d.Wakes, &d.HeldBy, &d.State); err != nil {
			t.Fatal(err)
		}
		out = append(out, d)
	}
	return out
}

func chatDeliveryOf(t *testing.T, f *world, recipient string, seq int64) *chatTestDelivery {
	for _, d := range chatDeliveries(t, f, recipient) {
		if d.Seq == seq {
			return &d
		}
	}
	return nil
}

func (x *chatFakeSessions) hire(t *testing.T, id, task, project string, channel *int64) protocol.Conversation {
	t.Helper()
	x.f.Core.Apply(protocol.FactHired{Session: protocol.Session{
		ID: id, Name: "帮工" + id, Agent: "lab", Runtime: "pi", Task: task, Project: &project, HiredAt: clock.NowMs(),
		Phase: protocol.Phase{Value: protocol.PhaseResting{}}, Channel: channel,
	}})
	thread := testkit.Await(t, "a job thread", func() (protocol.Conversation, bool) {
		c := chatConversation(x.f, x.f.Channel.JobThread(id))
		if c == nil {
			return protocol.Conversation{}, false
		}
		return *c, true
	})
	if d := x.Deliver(id, task, protocol.RunTrigger{Kind: protocol.RunTriggerKindIssue}); d.Kind != "run" {
		t.Fatalf("first turn: %+v", d)
	}
	testkit.Until(t, "its first report", func() bool {
		return slices.ContainsFunc(chatMessagesIn(x.f, thread.ID), func(m protocol.ChatMessage) bool {
			return m.Kind == protocol.MessageKindReport && m.From == id
		})
	})
	return thread
}

func chatNews(t *testing.T, news <-chan ManagerNews, seq int64) ManagerNews {
	t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case n := <-news:
			if slices.ContainsFunc(n.Messages, func(m protocol.InboxMessage) bool { return m.Seq == seq }) {
				return n
			}
		case <-timeout:
			t.Fatalf("the manager never heard of %d", seq)
		}
	}
}

func TestChatJobOpensThreadUnderDispatch(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	thread := x.hire(t, "w1", "写 hello", "chat-a", nil)
	general := protocol.GeneralOf(f.Core.State().Chat)
	if general == nil || general.ID != f.Channel.General() {
		t.Fatalf("general: %+v", general)
	}
	i := slices.IndexFunc(chatMessagesIn(f, general.ID), func(m protocol.ChatMessage) bool {
		return m.Kind == protocol.MessageKindDispatch && m.Session != nil && *m.Session == "w1"
	})
	if i < 0 {
		t.Fatal("no dispatch on the general channel")
	}
	dispatch := chatMessagesIn(f, general.ID)[i]
	if thread.Parent == nil || *thread.Parent != dispatch.Seq {
		t.Fatalf("thread under %v, dispatch %d", thread.Parent, dispatch.Seq)
	}
	if !strings.Contains(dispatch.Text, "派 @w1（帮工w1）去 chat-a：写 hello") {
		t.Fatalf("dispatch: %q", dispatch.Text)
	}
	var report protocol.ChatMessage
	for _, m := range chatMessagesIn(f, thread.ID) {
		if m.Kind == protocol.MessageKindReport {
			report = m
		}
	}
	if report.From != "w1" || report.FromKind != protocol.SenderKindAgent || report.Outcome == nil || *report.Outcome != protocol.OutcomeCompleted {
		t.Fatalf("report: %+v", report)
	}
	if !strings.Contains(report.Text, "收到了") || strings.Contains(report.Text, "结论") {
		t.Fatalf("report text: %q", report.Text)
	}
	if got := f.Channel.JobThread("w1"); got == nil || *got != thread.ID {
		t.Fatalf("JobThread: %v", got)
	}
}

func TestChatPersonInJobThreadWakesSession(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	thread := x.hire(t, "w2", "写 hello", "chat-b", nil)
	said, err := f.Channel.Say("把输出改成中文", &thread.ID)
	if err != nil {
		t.Fatal(err)
	}
	testkit.Until(t, "a second turn", func() bool { return len(x.runsOf("w2")) >= 2 })
	input := x.runsOf("w2")[1]
	want := fmt.Sprintf("[target=#田头:%d msg=%d from=主人] 把输出改成中文", *thread.Parent, said.Seq)
	if !strings.Contains(input, want) {
		t.Fatalf("input %q lacks %q", input, want)
	}
	testkit.Until(t, "seen", func() bool {
		d := chatDeliveryOf(t, f, "w2", said.Seq)
		return d != nil && d.State == "seen"
	})
	testkit.Until(t, "its reply in the thread", func() bool {
		n := 0
		for _, m := range chatMessagesIn(f, thread.ID) {
			if m.Kind == protocol.MessageKindReport {
				n++
			}
		}
		return n >= 2
	})
}

func TestChatGeneralReachesManager(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	x.hire(t, "w3", "写 hello", "chat-c", nil)
	news, stop := f.Channel.ForManager().Subscribe()
	defer stop()
	before := len(x.runsOf("w3"))
	said, err := f.Channel.Say("今天进度怎么样", nil)
	if err != nil {
		t.Fatal(err)
	}
	heard := chatNews(t, news, said.Seq)
	if len(heard.Messages) != 1 || heard.Messages[0].Text != "今天进度怎么样" || heard.Target != "#田头" || heard.Conversation != f.Channel.General() {
		t.Fatalf("news: %+v", heard)
	}
	testkit.Settle()
	if len(x.runsOf("w3")) != before {
		t.Fatal("a run for the session")
	}
	d := chatDeliveryOf(t, f, "w3", said.Seq)
	if d == nil || d.Reason != "general" || d.Wakes {
		t.Fatalf("passive delivery: %+v", d)
	}
	if d := chatDeliveryOf(t, f, protocol.ManagerAgent, said.Seq); d == nil || d.State != "seen" {
		t.Fatalf("the manager's delivery: %+v", d)
	}
}

func TestChatChannels(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	channel, err := f.Channel.OpenChannel("#clock-in", "打卡页", "chat-ch")
	if err != nil {
		t.Fatal(err)
	}
	if channel.Name != "clock-in" || channel.Project != "chat-ch" || channel.Description != "打卡页" {
		t.Fatalf("channel: %+v", channel)
	}
	if _, err := f.Channel.OpenChannel("clock-in", "", ""); err == nil || !strings.Contains(err.Error(), "已经有") {
		t.Fatalf("a second clock-in: %v", err)
	}
	var names []string
	for _, c := range f.Channel.Channels() {
		names = append(names, c.Name)
	}
	if !slices.Equal(names, []string{"田头", "clock-in"}) {
		t.Fatalf("channels: %v", names)
	}
	thread := x.hire(t, "w4", "写 hello", "chat-ch", &channel.ID)
	if thread.Channel == nil || *thread.Channel != channel.ID {
		t.Fatalf("thread's channel: %v", thread.Channel)
	}
	i := slices.IndexFunc(chatMessagesIn(f, channel.ID), func(m protocol.ChatMessage) bool {
		return m.Kind == protocol.MessageKindDispatch && m.Session != nil && *m.Session == "w4"
	})
	if i < 0 || *thread.Parent != chatMessagesIn(f, channel.ID)[i].Seq {
		t.Fatal("the dispatch is not in the channel, or the thread not under it")
	}
	x.hire(t, "w5", "写 hello", "chat-sq", nil)
	news, stop := f.Channel.ForManager().Subscribe()
	defer stop()
	said, err := f.Channel.Say("打卡页今天能好吗", &channel.ID)
	if err != nil {
		t.Fatal(err)
	}
	heard := chatNews(t, news, said.Seq)
	if heard.Conversation != channel.ID || heard.Target != "#clock-in" {
		t.Fatalf("news: %+v", heard)
	}
	if d := chatDeliveryOf(t, f, "w4", said.Seq); d == nil || d.Reason != "general" {
		t.Fatalf("the channel's session: %+v", d)
	}
	if d := chatDeliveryOf(t, f, "w5", said.Seq); d != nil {
		t.Fatalf("the general channel's session: %+v", d)
	}
	read, err := f.Channel.Read("w4", ReadOptions{Target: "#clock-in"})
	if err != nil || read.Target != "#clock-in" {
		t.Fatalf("read: %+v %v", read, err)
	}
	spoken, err := f.Channel.Speak("w4", "今天能好", SpeakOptions{Target: "#clock-in", Anyway: true, Confirm: true})
	if err != nil || spoken.Kind != "sent" {
		t.Fatalf("speak: %+v %v", spoken, err)
	}
	if _, err := f.Channel.Read("w4", ReadOptions{Target: "#nowhere"}); err == nil || !strings.Contains(err.Error(), "没有叫 #nowhere 的频道") {
		t.Fatalf("nowhere: %v", err)
	}
	if got := f.Channel.ChannelOf(thread.ID); got.Name != "clock-in" {
		t.Fatalf("ChannelOf: %+v", got)
	}
	empty := ""
	if err := f.Channel.UpdateChannel(channel.ID, nil, &empty); err != nil {
		t.Fatal(err)
	}
	got := f.Channel.ChannelByName("clock-in")
	if got == nil || got.Project != "" || got.Description != "打卡页" {
		t.Fatalf("after update: %+v", got)
	}
	if conv := protocol.ConversationOf(f.Core.State().Chat, channel.ID); conv == nil || conv.Project != nil {
		t.Fatalf("the core state's channel: %+v", conv)
	}
}

func TestChatBusySessionGetsOneNotice(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	project := "chat-d"
	f.Core.Apply(protocol.FactHired{Session: protocol.Session{
		ID: "w6", Name: "帮工w6", Agent: "lab", Runtime: "pi", Task: "慢慢做一个大活", Project: &project, HiredAt: clock.NowMs(),
		Phase: protocol.Phase{Value: protocol.PhaseResting{}},
	}})
	thread := testkit.Await(t, "a job thread", func() (protocol.Conversation, bool) {
		c := chatConversation(f, f.Channel.JobThread("w6"))
		if c == nil {
			return protocol.Conversation{}, false
		}
		return *c, true
	})
	x.Deliver("w6", "慢慢做一个大活", protocol.RunTrigger{Kind: protocol.RunTriggerKindComment})
	if h := f.Core.Session("w6"); h == nil || !protocol.IsBusy(*h) {
		t.Fatal("not working")
	}
	if _, err := f.Channel.Say("补充：顺便写测试", &thread.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Channel.Say("还有：写 README", &thread.ID); err != nil {
		t.Fatal(err)
	}
	testkit.Until(t, "a second turn", func() bool { return len(x.runsOf("w6")) >= 2 })
	var notices []string
	for _, s := range x.steersOf("w6") {
		if strings.HasPrefix(s, "[田头提示]") {
			notices = append(notices, s)
		}
	}
	if len(notices) != 1 {
		t.Fatalf("notices: %q", notices)
	}
	if !strings.Contains(notices[0], "2 条") || strings.Contains(notices[0], "写测试") {
		t.Fatalf("notice: %q", notices[0])
	}
	next := x.runsOf("w6")[1]
	if !strings.Contains(next, "补充：顺便写测试") || !strings.Contains(next, "还有：写 README") {
		t.Fatalf("next turn: %q", next)
	}
}

func TestChatHopLimit(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	thread := x.hire(t, "w7", "写 hello", "chat-e", nil)
	// The manager is never cooled down, so only the hop limit holds.
	for i := 1; i <= 5; i++ {
		spoken, err := f.Channel.Speak("w7", fmt.Sprintf("@管家 第 %d 次问", i), SpeakOptions{Anyway: true})
		if err != nil || spoken.Kind != "sent" {
			t.Fatalf("speak %d: %+v %v", i, spoken, err)
		}
	}
	var held []string
	for _, d := range chatDeliveries(t, f, protocol.ManagerAgent) {
		if d.Reason == "mention" {
			held = append(held, d.HeldBy)
		}
	}
	if !slices.Equal(held, []string{"", "", "", "", "hop_limit"}) {
		t.Fatalf("held: %q", held)
	}
	var notices []protocol.ChatMessage
	for _, m := range chatMessagesIn(f, thread.ID) {
		if m.Kind == protocol.MessageKindNotice {
			notices = append(notices, m)
		}
	}
	if len(notices) != 1 || !strings.Contains(notices[0].Text, "来回 4 次") {
		t.Fatalf("notices: %+v", notices)
	}
}

func TestChatWakeBreaker(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	a := x.hire(t, "w8", "写 hello", "chat-f", nil)
	x.hire(t, "w9", "写 world", "chat-g", nil)
	if _, err := f.Channel.Say("@w8 这次必败", nil); err != nil {
		t.Fatal(err)
	}
	testkit.Until(t, "the breaker notice", func() bool {
		return slices.ContainsFunc(chatMessagesIn(f, a.ID), func(m protocol.ChatMessage) bool {
			return m.Kind == protocol.MessageKindNotice && strings.Contains(m.Text, "一叫醒就失败")
		})
	})
	if n := len(x.runsOf("w8")); n != 1+protocol.WakeBreaker {
		t.Fatalf("turns: %d", n)
	}
	for _, d := range chatDeliveries(t, f, "w8") {
		if d.Reason == "mention" && d.State != "pending" {
			t.Fatalf("not given back: %+v", d)
		}
	}
	spoken, err := f.Channel.Speak("w9", "@w8 你那边怎么样", SpeakOptions{Anyway: true})
	if err != nil || spoken.Kind != "sent" {
		t.Fatalf("speak: %+v %v", spoken, err)
	}
	ds := chatDeliveries(t, f, "w8")
	if last := ds[len(ds)-1]; last.HeldBy != "wake_breaker" {
		t.Fatalf("from w9: %+v", last)
	}
	if _, err := f.Channel.Say("@w8 再试一次", nil); err != nil {
		t.Fatal(err)
	}
	testkit.Until(t, "woken by the person", func() bool {
		runs := x.runsOf("w8")
		return strings.Contains(runs[len(runs)-1], "再试一次")
	})
}

func TestChatSpeaking(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	thread := x.hire(t, "w10", "写 hello", "chat-h", nil)
	first, err := f.Channel.Speak("w10", "我先看看代码", SpeakOptions{})
	if err != nil || first.Kind != "sent" {
		t.Fatalf("first: %+v %v", first, err)
	}
	again, err := f.Channel.Speak("w10", "我先看看代码", SpeakOptions{})
	if err != nil || again.Kind != "sent" || again.Message.Seq != first.Message.Seq {
		t.Fatalf("a retry is the same message: %+v %v", again, err)
	}

	words, err := f.Channel.Say("先别动 main", &thread.ID)
	if err != nil {
		t.Fatal(err)
	}
	held, err := f.Channel.Speak("w10", "我改好了", SpeakOptions{})
	if err != nil || held.Kind != "held" || len(held.Shown) != 1 || held.Shown[0].Seq != words.Seq {
		t.Fatalf("held: %+v %v", held, err)
	}
	if sent, err := f.Channel.Speak("w10", "我改好了", SpeakOptions{}); err != nil || sent.Kind != "sent" {
		t.Fatalf("shown once, it goes through: %+v %v", sent, err)
	}

	if _, err := f.Channel.Read("w10", ReadOptions{}); err != nil {
		t.Fatal(err)
	}
	asked, err := f.Channel.Speak("w10", "大家好", SpeakOptions{Target: "#田头"})
	if err != nil || asked.Kind != "confirm" || asked.LastRead != fmt.Sprintf("#田头:%d", *thread.Parent) {
		t.Fatalf("asked: %+v %v", asked, err)
	}
	if sent, err := f.Channel.Speak("w10", "大家好", SpeakOptions{Target: "#田头", Confirm: true, Anyway: true}); err != nil || sent.Kind != "sent" {
		t.Fatalf("confirmed: %+v %v", sent, err)
	}
	absent, err := f.Channel.Speak("w10", "@w99 你在吗", SpeakOptions{Anyway: true})
	if err != nil || absent.Kind != "sent" || !slices.Contains(absent.NotOnFarm, "w99") {
		t.Fatalf("absent: %+v %v", absent, err)
	}
	if _, err := f.Channel.Speak("w10", "hi", SpeakOptions{Target: "#田头:999999"}); err == nil || !strings.Contains(err.Error(), "没有 999999 这条消息") {
		t.Fatalf("a thread under nothing: %v", err)
	}
	if _, err := f.Channel.Speak("w10", "接着说", SpeakOptions{Target: fmt.Sprintf("#田头:%d", absent.Message.Seq), Anyway: true}); err == nil {
		t.Fatal("a thread under a thread's message")
	}
	general := f.Channel.General()
	sq, err := f.Channel.Say("大家早", &general)
	if err != nil {
		t.Fatal(err)
	}
	talk, err := f.Channel.Speak("w10", "早", SpeakOptions{Target: fmt.Sprintf("#田头:%d", sq.Seq), Anyway: true})
	if err != nil || talk.Kind != "sent" || talk.Target != fmt.Sprintf("#田头:%d", sq.Seq) {
		t.Fatalf("talk: %+v %v", talk, err)
	}
	under, _ := f.Channel.store().threadByParent(sq.Seq)
	if under := chatConversation(f, under); under == nil || under.SubjectKind == nil || *under.SubjectKind != protocol.SubjectKindTalk {
		t.Fatalf("talk thread: %+v", under)
	}
}

func TestChatManagerSaysGrowsThenDelivers(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	x.hire(t, "w11", "写 hello", "chat-k", nil)
	general := f.Channel.General()
	f.Channel.ManagerSays(general, "k1", "", false)
	f.Channel.ManagerSays(general, "k1", "好的，", false)
	f.Channel.ManagerSays(general, "k1", "好的，我叫 @w11 去", false)
	ours := func() []protocol.ChatMessage {
		var out []protocol.ChatMessage
		for _, m := range chatMessagesIn(f, general) {
			if m.From == protocol.ManagerAgent && m.Kind == protocol.MessageKindChat {
				out = append(out, m)
			}
		}
		return out
	}
	if got := ours(); len(got) != 1 || got[0].Final || got[0].Text != "好的，我叫 @w11 去" {
		t.Fatalf("growing: %+v", got)
	}
	if d := chatDeliveryOf(t, f, "w11", ours()[0].Seq); d != nil {
		t.Fatalf("delivered before final: %+v", d)
	}
	f.Channel.ManagerSays(general, "k1", "好的，我叫 @w11 去看看", true)
	got := ours()
	if len(got) != 1 || !got[0].Final || !slices.Equal(got[0].Mentions, []string{"w11"}) {
		t.Fatalf("final: %+v", got)
	}
	testkit.Until(t, "w11 woken", func() bool {
		runs := x.runsOf("w11")
		return len(runs) >= 2 && strings.Contains(runs[1], "我叫 @w11 去看看")
	})
	f.Channel.Notice(general, "定时到了", "schedule")
	testkit.Settle()
	ms := chatMessagesIn(f, general)
	if last := ms[len(ms)-1]; last.Kind != protocol.MessageKindNotice || last.From != "system" {
		t.Fatalf("notice: %+v", last)
	}
	if ds := chatDeliveries(t, f, "w11"); ds[len(ds)-1].Seq == ms[len(ms)-1].Seq {
		t.Fatal("a notice was delivered")
	}
}

func TestChatHistoryAndMarkRead(t *testing.T) {
	f, _ := chatTestFarm(t, t.TempDir(), ":memory:")
	general := f.Channel.General()
	var seqs []int64
	for i := range 5 {
		m, err := f.Channel.Say(fmt.Sprintf("第 %d 句", i), &general)
		if err != nil {
			t.Fatal(err)
		}
		seqs = append(seqs, m.Seq)
	}
	limit, before := int64(2), seqs[4]
	got, err := f.Channel.History(general, &before, &limit)
	if err != nil || len(got) != 2 || got[0].Seq != seqs[2] || got[1].Seq != seqs[3] {
		t.Fatalf("history: %+v %v", got, err)
	}
	if err := f.Channel.MarkRead(general, seqs[1]); err != nil {
		t.Fatal(err)
	}
	if err := f.Channel.MarkRead(9999, 1); err == nil {
		t.Fatal("marked a conversation that is not there")
	}
	sq := protocol.GeneralOf(f.Core.State().Chat)
	if sq == nil || sq.Read == nil || *sq.Read != seqs[4] {
		t.Fatalf("read: %+v", sq)
	}
	if _, err := f.Channel.Say("  ", nil); err == nil {
		t.Fatal("said nothing")
	}
	if digest := f.Channel.ManagerDigest(); len(digest) != 0 {
		t.Fatalf("digest: %+v", digest)
	}
}

func TestChatInboxAndDigest(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	thread := x.hire(t, "w12", "写 hello", "chat-l", nil)
	digest := f.Channel.ManagerDigest()
	if len(digest) != 1 || digest[0].From != "w12" || digest[0].Target != fmt.Sprintf("#田头:%d", *thread.Parent) {
		t.Fatalf("digest: %+v", digest)
	}
	if again := f.Channel.ManagerDigest(); len(again) != 0 {
		t.Fatalf("digest again: %+v", again)
	}
	general := f.Channel.General()
	if _, err := f.Channel.Say("大家看一下", &general); err != nil {
		t.Fatal(err)
	}
	inbox := f.Channel.Inbox("w12")
	if len(inbox) != 1 || inbox[0].Target != "#田头" || inbox[0].Unread != 2 || inbox[0].Latest != "主人" || !inbox[0].MentionsYou {
		t.Fatalf("inbox: %+v", inbox)
	}
	if _, err := f.Channel.Read("w12", ReadOptions{Target: "#田头"}); err != nil {
		t.Fatal(err)
	}
	if inbox := f.Channel.Inbox("w12"); len(inbox) != 0 {
		t.Fatalf("inbox after reading: %+v", inbox)
	}
}

func TestChatSessionLeaves(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	x.hire(t, "w13", "写 hello", "chat-m", nil)
	testkit.Until(t, "resting", func() bool {
		h := f.Core.Session("w13")
		return h != nil && !protocol.IsBusy(*h)
	})
	general := f.Channel.General()
	if _, err := f.Channel.Say("随便说说", &general); err != nil {
		t.Fatal(err)
	}
	f.Core.Apply(protocol.FactLeft{ID: "w13"})
	testkit.Until(t, "dropped", func() bool {
		ds := chatDeliveries(t, f, "w13")
		return len(ds) > 0 && ds[len(ds)-1].State == "dropped"
	})
	var left *int64
	if err := f.DB.QueryRow(`select left_at from channel_participant where id = 'w13'`).Scan(&left); err != nil || left == nil {
		t.Fatalf("left_at: %v %v", left, err)
	}
}

func TestChatRestartGivesHandedWordsAgain(t *testing.T) {
	home := t.TempDir()
	db := filepath.Join(home, "vibevalley.db")
	f, x := chatTestFarm(t, home, db)
	thread := x.hire(t, "w14", "写 hello", "chat-i", nil)
	x.slow = time.Minute
	said, err := f.Channel.Say("慢慢做：再加一个文件", &thread.ID)
	if err != nil {
		t.Fatal(err)
	}
	testkit.Until(t, "handed", func() bool {
		d := chatDeliveryOf(t, f, "w14", said.Seq)
		return d != nil && d.State == "handed"
	})
	x.close()

	savedJSON := `{"hired":14,"hands":[{"id":"w14","place":{"project":"chat-i","cwd":"` + t.TempDir() + `"}}]}`
	if err := os.WriteFile(filepath.Join(home, "sessions.json"), []byte(savedJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	g, y := chatTestFarm(t, home, db)
	y.slow = 10 * time.Millisecond
	if g.Core.Session("w14") == nil {
		t.Fatal("the session did not come back")
	}
	g.Core.Apply(protocol.FactReport{ID: "w14", Outcome: protocol.OutcomeInterrupted, Summary: "重启了"})
	testkit.Until(t, "seen after the restart", func() bool {
		d := chatDeliveryOf(t, g, "w14", said.Seq)
		return d != nil && d.State == "seen"
	})
	runs := y.runsOf("w14")
	if len(runs) == 0 || !strings.Contains(runs[len(runs)-1], "再加一个文件") {
		t.Fatalf("turns: %q", runs)
	}
	if c := chatConversation(g, g.Channel.JobThread("w14")); c == nil || c.ID != thread.ID {
		t.Fatalf("job thread after restart: %+v", c)
	}
	if !slices.ContainsFunc(chatMessagesIn(g, thread.ID), func(m protocol.ChatMessage) bool { return m.Seq == said.Seq }) {
		t.Fatal("the message did not come back")
	}
}

func TestChatSummaryOf(t *testing.T) {
	for _, c := range []struct{ in, want string }{
		{"先看看。\n\n**结论：** 改好了，测试通过。\n\n备注：无", "改好了，测试通过。"},
		{"做了一些事\n\n- 结论：好了", "好了"},
		{"第一段\n\n第二段", "第一段\n\n第二段"},
	} {
		if got := session.SummaryOf(c.in); got != c.want {
			t.Errorf("SummaryOf(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	if got := str.Head("😀abc", 1); got != "" {
		t.Errorf("clip: %q", got)
	}
}
