package chat

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
	"vibevalley/internal/farmtest"
	"vibevalley/internal/protocol"
	"vibevalley/internal/runs"
)

type chatFakeCrew struct {
	f     *world
	hub   *base.Hub[base.SessionActivity]
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

func (x *chatFakeCrew) Activity() *base.Hub[base.SessionActivity] { return x.hub }

func (x *chatFakeCrew) Find(id string) *base.Roster {
	h := x.f.Site.Helper(id)
	if h == nil {
		return nil
	}
	x.mu.Lock()
	defer x.mu.Unlock()
	return &base.Roster{Helper: *h, LastText: x.last[id]}
}

func (x *chatFakeCrew) Deliver(id, text string) base.Delivered {
	if x.f.Site.Helper(id) == nil {
		return base.Delivered{Kind: "refused", Reason: "不在地里"}
	}
	x.mu.Lock()
	if session, ok := x.running[id]; ok {
		x.steers[id] = append(x.steers[id], text)
		x.mu.Unlock()
		return base.Delivered{Kind: "steered", Session: session}
	}
	x.n++
	session := fmt.Sprintf("%s-%d", id, x.n)
	x.running[id] = session
	x.inputs[id] = append(x.inputs[id], text)
	x.mu.Unlock()
	x.f.Site.Apply(protocol.FactTurn{ID: id})
	go x.turn(id, session, text)
	return base.Delivered{Kind: "turn", Session: session, Woke: true}
}

func (x *chatFakeCrew) turn(id, session, input string) {
	if strings.Contains(input, "慢慢做") {
		select {
		case <-time.After(x.slow):
		case <-x.stop:
			return
		}
	}
	x.mu.Lock()
	turns := int64(len(x.inputs[id]))
	x.mu.Unlock()
	if strings.Contains(input, "必败") {
		x.mu.Lock()
		delete(x.running, id)
		x.mu.Unlock()
		x.f.Site.Apply(protocol.FactReport{ID: id, Outcome: protocol.OutcomeFailed, Summary: "provider said no", Turns: turns})
		x.hub.Publish(base.SessionActivity{Kind: "ended", ID: id, Session: session, Outcome: protocol.OutcomeFailed})
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
		line = chatClip(input, 20)
	}
	x.mu.Lock()
	x.last[id] = "结论：收到了（" + line + "）"
	x.mu.Unlock()
	x.hub.Publish(base.SessionActivity{Kind: "spoke", ID: id, Session: session})
	x.mu.Lock()
	delete(x.running, id)
	x.mu.Unlock()
	x.f.Site.Apply(protocol.FactReport{ID: id, Outcome: protocol.OutcomeCompleted, Summary: "收到了", Turns: turns})
	x.hub.Publish(base.SessionActivity{Kind: "ended", ID: id, Session: session, Outcome: protocol.OutcomeCompleted, Spoke: true})
}

func (x *chatFakeCrew) turnsOf(id string) []string {
	x.mu.Lock()
	defer x.mu.Unlock()
	return slices.Clone(x.inputs[id])
}

func (x *chatFakeCrew) steersOf(id string) []string {
	x.mu.Lock()
	defer x.mu.Unlock()
	return slices.Clone(x.steers[id])
}

func chatTestFarm(t *testing.T, home, dbPath string) (*world, *chatFakeCrew) {
	t.Helper()
	f, err := newWorld(base.Config{Home: home, WorkRoot: t.TempDir(), DBPath: dbPath})
	if err != nil {
		t.Fatal(err)
	}
	x := &chatFakeCrew{
		f: f, hub: base.NewHub[base.SessionActivity](), slow: 1500 * time.Millisecond, stop: make(chan struct{}),
		inputs: map[string][]string{}, steers: map[string][]string{}, last: map[string]string{}, running: map[string]string{},
	}
	f.Chat.crew = x
	f.Chat.noticeEvery = 300 * time.Millisecond
	f.Chat.retryWake = 100 * time.Millisecond
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
	chat := f.Site.State().Chat
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
	rows, err := f.DB.Query(`select message_seq, reason, wakes, coalesce(held_by, ''), state from deliveries where recipient_id = ? order by message_seq`, recipient)
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

func (x *chatFakeCrew) hire(t *testing.T, id, task, project string, channel *int64) protocol.Conversation {
	t.Helper()
	x.f.Site.Apply(protocol.FactHired{Helper: protocol.Helper{
		ID: id, Name: "帮工" + id, Agent: "lab", Runtime: "pi", Task: task, Project: &project, HiredAt: base.NowMs(),
		Phase: protocol.Phase{Value: protocol.PhaseResting{}}, Channel: channel,
	}})
	thread := farmtest.Await(t, "a job thread", func() (protocol.Conversation, bool) {
		c := protocol.JobThreadOf(x.f.Site.State().Chat, id)
		if c == nil {
			return protocol.Conversation{}, false
		}
		return *c, true
	})
	if d := x.Deliver(id, task); d.Kind != "turn" {
		t.Fatalf("first turn: %+v", d)
	}
	farmtest.Await(t, "its first report", func() (bool, bool) {
		return true, slices.ContainsFunc(chatMessagesIn(x.f, thread.ID), func(m protocol.ChatMessage) bool {
			return m.Kind == protocol.MessageKindReport && m.From == id
		})
	})
	return thread
}

func chatNews(t *testing.T, news <-chan base.ForemanNews, seq int64) base.ForemanNews {
	t.Helper()
	timeout := time.After(5 * time.Second)
	for {
		select {
		case n := <-news:
			if slices.ContainsFunc(n.Messages, func(m base.InboxMessage) bool { return m.Seq == seq }) {
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
	square := protocol.SquareOf(f.Site.State().Chat)
	if square == nil || square.ID != f.Chat.Square() {
		t.Fatalf("square: %+v", square)
	}
	i := slices.IndexFunc(chatMessagesIn(f, square.ID), func(m protocol.ChatMessage) bool {
		return m.Kind == protocol.MessageKindDispatch && m.Helper != nil && *m.Helper == "w1"
	})
	if i < 0 {
		t.Fatal("no dispatch on the square")
	}
	dispatch := chatMessagesIn(f, square.ID)[i]
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
	if report.From != "w1" || report.FromKind != protocol.SenderKindHelper || report.Outcome == nil || *report.Outcome != protocol.OutcomeCompleted {
		t.Fatalf("report: %+v", report)
	}
	if !strings.Contains(report.Text, "收到了") || strings.Contains(report.Text, "结论") {
		t.Fatalf("report text: %q", report.Text)
	}
	if got := f.Chat.JobThread("w1"); got == nil || *got != thread.ID {
		t.Fatalf("JobThread: %v", got)
	}
}

func TestChatPersonInJobThreadWakesHelper(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	thread := x.hire(t, "w2", "写 hello", "chat-b", nil)
	said, err := f.Chat.Say("把输出改成中文", &thread.ID)
	if err != nil {
		t.Fatal(err)
	}
	farmtest.Await(t, "a second turn", func() (bool, bool) { return true, len(x.turnsOf("w2")) >= 2 })
	input := x.turnsOf("w2")[1]
	want := fmt.Sprintf("[target=#田头:%d msg=%d from=主人] 把输出改成中文", *thread.Parent, said.Seq)
	if !strings.Contains(input, want) {
		t.Fatalf("input %q lacks %q", input, want)
	}
	farmtest.Await(t, "seen", func() (bool, bool) {
		d := chatDeliveryOf(t, f, "w2", said.Seq)
		return true, d != nil && d.State == "seen"
	})
	farmtest.Await(t, "its reply in the thread", func() (bool, bool) {
		n := 0
		for _, m := range chatMessagesIn(f, thread.ID) {
			if m.Kind == protocol.MessageKindReport {
				n++
			}
		}
		return true, n >= 2
	})
}

func TestChatSquareReachesManager(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	x.hire(t, "w3", "写 hello", "chat-c", nil)
	news, stop := f.Chat.ForForeman().Subscribe()
	defer stop()
	before := len(x.turnsOf("w3"))
	said, err := f.Chat.Say("今天进度怎么样", nil)
	if err != nil {
		t.Fatal(err)
	}
	heard := chatNews(t, news, said.Seq)
	if len(heard.Messages) != 1 || heard.Messages[0].Text != "今天进度怎么样" || heard.Target != "#田头" || heard.Conversation != f.Chat.Square() {
		t.Fatalf("news: %+v", heard)
	}
	time.Sleep(500 * time.Millisecond)
	if len(x.turnsOf("w3")) != before {
		t.Fatal("a turn for the helper")
	}
	d := chatDeliveryOf(t, f, "w3", said.Seq)
	if d == nil || d.Reason != "square" || d.Wakes {
		t.Fatalf("passive delivery: %+v", d)
	}
	if d := chatDeliveryOf(t, f, "foreman", said.Seq); d == nil || d.State != "seen" {
		t.Fatalf("the manager's delivery: %+v", d)
	}
}

func TestChatChannels(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	channel, err := f.Chat.OpenChannel("#clock-in", "打卡页", "chat-ch")
	if err != nil {
		t.Fatal(err)
	}
	if channel.Name != "clock-in" || channel.Project != "chat-ch" || channel.Description != "打卡页" {
		t.Fatalf("channel: %+v", channel)
	}
	if _, err := f.Chat.OpenChannel("clock-in", "", ""); err == nil || !strings.Contains(err.Error(), "已经有") {
		t.Fatalf("a second clock-in: %v", err)
	}
	var names []string
	for _, c := range f.Chat.Channels() {
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
		return m.Kind == protocol.MessageKindDispatch && m.Helper != nil && *m.Helper == "w4"
	})
	if i < 0 || *thread.Parent != chatMessagesIn(f, channel.ID)[i].Seq {
		t.Fatal("the dispatch is not in the channel, or the thread not under it")
	}
	x.hire(t, "w5", "写 hello", "chat-sq", nil)
	news, stop := f.Chat.ForForeman().Subscribe()
	defer stop()
	said, err := f.Chat.Say("打卡页今天能好吗", &channel.ID)
	if err != nil {
		t.Fatal(err)
	}
	heard := chatNews(t, news, said.Seq)
	if heard.Conversation != channel.ID || heard.Target != "#clock-in" {
		t.Fatalf("news: %+v", heard)
	}
	if d := chatDeliveryOf(t, f, "w4", said.Seq); d == nil || d.Reason != "square" {
		t.Fatalf("the channel's helper: %+v", d)
	}
	if d := chatDeliveryOf(t, f, "w5", said.Seq); d != nil {
		t.Fatalf("the square's helper: %+v", d)
	}
	read, err := f.Chat.Read("w4", base.ReadOptions{Target: "#clock-in"})
	if err != nil || read.Target != "#clock-in" {
		t.Fatalf("read: %+v %v", read, err)
	}
	spoken, err := f.Chat.Speak("w4", "今天能好", base.SpeakOptions{Target: "#clock-in", Anyway: true, Confirm: true})
	if err != nil || spoken.Kind != "sent" {
		t.Fatalf("speak: %+v %v", spoken, err)
	}
	if _, err := f.Chat.Read("w4", base.ReadOptions{Target: "#nowhere"}); err == nil || !strings.Contains(err.Error(), "没有叫 #nowhere 的频道") {
		t.Fatalf("nowhere: %v", err)
	}
	if got := f.Chat.ChannelOf(thread.ID); got.Name != "clock-in" {
		t.Fatalf("ChannelOf: %+v", got)
	}
	empty := ""
	if err := f.Chat.UpdateChannel(channel.ID, nil, &empty); err != nil {
		t.Fatal(err)
	}
	got := f.Chat.ChannelByName("clock-in")
	if got == nil || got.Project != "" || got.Description != "打卡页" {
		t.Fatalf("after update: %+v", got)
	}
	if conv := protocol.ConversationOf(f.Site.State().Chat, channel.ID); conv == nil || conv.Project != nil {
		t.Fatalf("the core state's channel: %+v", conv)
	}
}

func TestChatBusyHelperGetsOneNotice(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	project := "chat-d"
	f.Site.Apply(protocol.FactHired{Helper: protocol.Helper{
		ID: "w6", Name: "帮工w6", Agent: "lab", Runtime: "pi", Task: "慢慢做一个大活", Project: &project, HiredAt: base.NowMs(),
		Phase: protocol.Phase{Value: protocol.PhaseResting{}},
	}})
	thread := farmtest.Await(t, "a job thread", func() (protocol.Conversation, bool) {
		c := protocol.JobThreadOf(f.Site.State().Chat, "w6")
		if c == nil {
			return protocol.Conversation{}, false
		}
		return *c, true
	})
	x.Deliver("w6", "慢慢做一个大活")
	if h := f.Site.Helper("w6"); h == nil || !protocol.IsBusy(*h) {
		t.Fatal("not working")
	}
	if _, err := f.Chat.Say("补充：顺便写测试", &thread.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := f.Chat.Say("还有：写 README", &thread.ID); err != nil {
		t.Fatal(err)
	}
	farmtest.Await(t, "a second turn", func() (bool, bool) { return true, len(x.turnsOf("w6")) >= 2 })
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
	next := x.turnsOf("w6")[1]
	if !strings.Contains(next, "补充：顺便写测试") || !strings.Contains(next, "还有：写 README") {
		t.Fatalf("next turn: %q", next)
	}
}

func TestChatHopLimit(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	thread := x.hire(t, "w7", "写 hello", "chat-e", nil)
	// The manager is never cooled down, so only the hop limit holds.
	for i := 1; i <= 5; i++ {
		spoken, err := f.Chat.Speak("w7", fmt.Sprintf("@管家 第 %d 次问", i), base.SpeakOptions{Anyway: true})
		if err != nil || spoken.Kind != "sent" {
			t.Fatalf("speak %d: %+v %v", i, spoken, err)
		}
	}
	var held []string
	for _, d := range chatDeliveries(t, f, "foreman") {
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
	if _, err := f.Chat.Say("@w8 这次必败", nil); err != nil {
		t.Fatal(err)
	}
	farmtest.Await(t, "the breaker notice", func() (bool, bool) {
		return true, slices.ContainsFunc(chatMessagesIn(f, a.ID), func(m protocol.ChatMessage) bool {
			return m.Kind == protocol.MessageKindNotice && strings.Contains(m.Text, "一叫醒就失败")
		})
	})
	if n := len(x.turnsOf("w8")); n != 1+protocol.WakeBreaker {
		t.Fatalf("turns: %d", n)
	}
	for _, d := range chatDeliveries(t, f, "w8") {
		if d.Reason == "mention" && d.State != "pending" {
			t.Fatalf("not given back: %+v", d)
		}
	}
	spoken, err := f.Chat.Speak("w9", "@w8 你那边怎么样", base.SpeakOptions{Anyway: true})
	if err != nil || spoken.Kind != "sent" {
		t.Fatalf("speak: %+v %v", spoken, err)
	}
	ds := chatDeliveries(t, f, "w8")
	if last := ds[len(ds)-1]; last.HeldBy != "wake_breaker" {
		t.Fatalf("from w9: %+v", last)
	}
	if _, err := f.Chat.Say("@w8 再试一次", nil); err != nil {
		t.Fatal(err)
	}
	farmtest.Await(t, "woken by the person", func() (bool, bool) {
		turns := x.turnsOf("w8")
		return true, strings.Contains(turns[len(turns)-1], "再试一次")
	})
}

func TestChatSpeaking(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	thread := x.hire(t, "w10", "写 hello", "chat-h", nil)
	first, err := f.Chat.Speak("w10", "我先看看代码", base.SpeakOptions{})
	if err != nil || first.Kind != "sent" {
		t.Fatalf("first: %+v %v", first, err)
	}
	again, err := f.Chat.Speak("w10", "我先看看代码", base.SpeakOptions{})
	if err != nil || again.Kind != "sent" || again.Message.Seq != first.Message.Seq {
		t.Fatalf("a retry is the same message: %+v %v", again, err)
	}

	words, err := f.Chat.Say("先别动 main", &thread.ID)
	if err != nil {
		t.Fatal(err)
	}
	held, err := f.Chat.Speak("w10", "我改好了", base.SpeakOptions{})
	if err != nil || held.Kind != "held" || len(held.Shown) != 1 || held.Shown[0].Seq != words.Seq {
		t.Fatalf("held: %+v %v", held, err)
	}
	if sent, err := f.Chat.Speak("w10", "我改好了", base.SpeakOptions{}); err != nil || sent.Kind != "sent" {
		t.Fatalf("shown once, it goes through: %+v %v", sent, err)
	}

	if _, err := f.Chat.Read("w10", base.ReadOptions{}); err != nil {
		t.Fatal(err)
	}
	asked, err := f.Chat.Speak("w10", "大家好", base.SpeakOptions{Target: "#田头"})
	if err != nil || asked.Kind != "confirm" || asked.LastRead != fmt.Sprintf("#田头:%d", *thread.Parent) {
		t.Fatalf("asked: %+v %v", asked, err)
	}
	if sent, err := f.Chat.Speak("w10", "大家好", base.SpeakOptions{Target: "#田头", Confirm: true, Anyway: true}); err != nil || sent.Kind != "sent" {
		t.Fatalf("confirmed: %+v %v", sent, err)
	}
	absent, err := f.Chat.Speak("w10", "@w99 你在吗", base.SpeakOptions{Anyway: true})
	if err != nil || absent.Kind != "sent" || !slices.Contains(absent.NotOnFarm, "w99") {
		t.Fatalf("absent: %+v %v", absent, err)
	}
	if _, err := f.Chat.Speak("w10", "hi", base.SpeakOptions{Target: "#田头:999999"}); err == nil || !strings.Contains(err.Error(), "没有 999999 这条消息") {
		t.Fatalf("a thread under nothing: %v", err)
	}
	if _, err := f.Chat.Speak("w10", "接着说", base.SpeakOptions{Target: fmt.Sprintf("#田头:%d", absent.Message.Seq), Anyway: true}); err == nil {
		t.Fatal("a thread under a thread's message")
	}
	square := f.Chat.Square()
	sq, err := f.Chat.Say("大家早", &square)
	if err != nil {
		t.Fatal(err)
	}
	talk, err := f.Chat.Speak("w10", "早", base.SpeakOptions{Target: fmt.Sprintf("#田头:%d", sq.Seq), Anyway: true})
	if err != nil || talk.Kind != "sent" || talk.Target != fmt.Sprintf("#田头:%d", sq.Seq) {
		t.Fatalf("talk: %+v %v", talk, err)
	}
	if under := protocol.ThreadUnder(f.Site.State().Chat, sq.Seq); under == nil || under.SubjectKind == nil || *under.SubjectKind != protocol.SubjectKindTalk {
		t.Fatalf("talk thread: %+v", under)
	}
}

func TestChatForemanSaysGrowsThenDelivers(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	x.hire(t, "w11", "写 hello", "chat-k", nil)
	square := f.Chat.Square()
	f.Chat.ForemanSays(square, "k1", "", false)
	f.Chat.ForemanSays(square, "k1", "好的，", false)
	f.Chat.ForemanSays(square, "k1", "好的，我叫 @w11 去", false)
	ours := func() []protocol.ChatMessage {
		var out []protocol.ChatMessage
		for _, m := range chatMessagesIn(f, square) {
			if m.From == "foreman" && m.Kind == protocol.MessageKindChat {
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
	f.Chat.ForemanSays(square, "k1", "好的，我叫 @w11 去看看", true)
	got := ours()
	if len(got) != 1 || !got[0].Final || !slices.Equal(got[0].Mentions, []string{"w11"}) {
		t.Fatalf("final: %+v", got)
	}
	farmtest.Await(t, "w11 woken", func() (bool, bool) {
		turns := x.turnsOf("w11")
		return true, len(turns) >= 2 && strings.Contains(turns[1], "我叫 @w11 去看看")
	})
	f.Chat.Notice(square, "定时到了", "schedule")
	time.Sleep(200 * time.Millisecond)
	ms := chatMessagesIn(f, square)
	if last := ms[len(ms)-1]; last.Kind != protocol.MessageKindNotice || last.From != "system" {
		t.Fatalf("notice: %+v", last)
	}
	if ds := chatDeliveries(t, f, "w11"); ds[len(ds)-1].Seq == ms[len(ms)-1].Seq {
		t.Fatal("a notice was delivered")
	}
}

func TestChatHistoryAndMarkRead(t *testing.T) {
	f, _ := chatTestFarm(t, t.TempDir(), ":memory:")
	square := f.Chat.Square()
	var seqs []int64
	for i := range 5 {
		m, err := f.Chat.Say(fmt.Sprintf("第 %d 句", i), &square)
		if err != nil {
			t.Fatal(err)
		}
		seqs = append(seqs, m.Seq)
	}
	limit, before := int64(2), seqs[4]
	got, err := f.Chat.History(square, &before, &limit)
	if err != nil || len(got) != 2 || got[0].Seq != seqs[2] || got[1].Seq != seqs[3] {
		t.Fatalf("history: %+v %v", got, err)
	}
	if err := f.Chat.MarkRead(square, seqs[1]); err != nil {
		t.Fatal(err)
	}
	if err := f.Chat.MarkRead(9999, 1); err == nil {
		t.Fatal("marked a conversation that is not there")
	}
	sq := protocol.SquareOf(f.Site.State().Chat)
	if sq == nil || sq.Read == nil || *sq.Read != seqs[4] {
		t.Fatalf("read: %+v", sq)
	}
	if _, err := f.Chat.Say("  ", nil); err == nil {
		t.Fatal("said nothing")
	}
	if digest := f.Chat.ForemanDigest(); len(digest) != 0 {
		t.Fatalf("digest: %+v", digest)
	}
}

func TestChatInboxAndDigest(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	thread := x.hire(t, "w12", "写 hello", "chat-l", nil)
	digest := f.Chat.ForemanDigest()
	if len(digest) != 1 || digest[0].From != "w12" || digest[0].Target != fmt.Sprintf("#田头:%d", *thread.Parent) {
		t.Fatalf("digest: %+v", digest)
	}
	if again := f.Chat.ForemanDigest(); len(again) != 0 {
		t.Fatalf("digest again: %+v", again)
	}
	square := f.Chat.Square()
	if _, err := f.Chat.Say("大家看一下", &square); err != nil {
		t.Fatal(err)
	}
	inbox := f.Chat.Inbox("w12")
	if len(inbox) != 1 || inbox[0].Target != "#田头" || inbox[0].Unread != 2 || inbox[0].Latest != "主人" || !inbox[0].MentionsYou {
		t.Fatalf("inbox: %+v", inbox)
	}
	if _, err := f.Chat.Read("w12", base.ReadOptions{Target: "#田头"}); err != nil {
		t.Fatal(err)
	}
	if inbox := f.Chat.Inbox("w12"); len(inbox) != 0 {
		t.Fatalf("inbox after reading: %+v", inbox)
	}
}

func TestChatHelperLeaves(t *testing.T) {
	f, x := chatTestFarm(t, t.TempDir(), ":memory:")
	x.hire(t, "w13", "写 hello", "chat-m", nil)
	farmtest.Await(t, "resting", func() (bool, bool) {
		h := f.Site.Helper("w13")
		return true, h != nil && !protocol.IsBusy(*h)
	})
	square := f.Chat.Square()
	if _, err := f.Chat.Say("随便说说", &square); err != nil {
		t.Fatal(err)
	}
	f.Site.Apply(protocol.FactLeft{ID: "w13"})
	farmtest.Await(t, "dropped", func() (bool, bool) {
		ds := chatDeliveries(t, f, "w13")
		return true, len(ds) > 0 && ds[len(ds)-1].State == "dropped"
	})
	var left *int64
	if err := f.DB.QueryRow(`select left_at from participants where id = 'w13'`).Scan(&left); err != nil || left == nil {
		t.Fatalf("left_at: %v %v", left, err)
	}
}

func TestChatRestartGivesHandedWordsAgain(t *testing.T) {
	home := t.TempDir()
	db := filepath.Join(home, "farm.db")
	f, x := chatTestFarm(t, home, db)
	thread := x.hire(t, "w14", "写 hello", "chat-i", nil)
	x.slow = time.Minute
	said, err := f.Chat.Say("慢慢做：再加一个文件", &thread.ID)
	if err != nil {
		t.Fatal(err)
	}
	farmtest.Await(t, "handed", func() (bool, bool) {
		d := chatDeliveryOf(t, f, "w14", said.Seq)
		return true, d != nil && d.State == "handed"
	})
	x.close()

	crewJSON := `{"hired":14,"hands":[{"id":"w14","place":{"project":"chat-i","cwd":"` + t.TempDir() + `"}}]}`
	if err := os.WriteFile(filepath.Join(home, "crew.json"), []byte(crewJSON), 0o644); err != nil {
		t.Fatal(err)
	}
	g, y := chatTestFarm(t, home, db)
	y.slow = 10 * time.Millisecond
	if g.Site.Helper("w14") == nil {
		t.Fatal("the helper did not come back")
	}
	g.Site.Apply(protocol.FactReport{ID: "w14", Outcome: protocol.OutcomeInterrupted, Summary: "重启了"})
	farmtest.Await(t, "seen after the restart", func() (bool, bool) {
		d := chatDeliveryOf(t, g, "w14", said.Seq)
		return true, d != nil && d.State == "seen"
	})
	turns := y.turnsOf("w14")
	if len(turns) == 0 || !strings.Contains(turns[len(turns)-1], "再加一个文件") {
		t.Fatalf("turns: %q", turns)
	}
	if c := protocol.JobThreadOf(g.Site.State().Chat, "w14"); c == nil || c.ID != thread.ID {
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
		if got := runs.SummaryOf(c.in); got != c.want {
			t.Errorf("crewSummaryOf(%q) = %q, want %q", c.in, got, c.want)
		}
	}
	if got := chatClip("😀abc", 1); got != "" {
		t.Errorf("clip: %q", got)
	}
}
