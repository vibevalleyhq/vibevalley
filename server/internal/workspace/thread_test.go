package workspace

import (
	"context"
	"slices"
	"strings"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/oartest"
	"vibevalley/pkg/x/ptr"
)

// One issue, one thread: sent out, cancelled and reopened, both sessions' dispatch, reports and the person's words are in the
// same thread; the person's words wake the session working the issue now, and only keep when none is.
func TestOneIssueKeepsOneThreadAcrossItsSessions(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	// Says only that it is done: echoing its input would @ the manager, who would then follow the thread.
	registry, _ := oar.NewRuntimeRegistry(oartest.Runtime(oartest.Options{ID: "pi", Turn: func(turn *oartest.Turn) error {
		turn.Say("做好了")
		return nil
	}}))
	w.f.Runtime.UseRegistry(registry)
	ctx, cancel := context.WithCancel(context.Background())
	if err := w.f.Channel.OnStart(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); w.f.Channel.OnStop() })
	lab := fixture.Lab(t)
	w.f.Agent.SaveAgent(lab)
	issue, err := w.f.Issue.Add(protocol.IssueRequest{Title: "写打卡", Project: ptr.To("one-thread"), Assignee: &lab.ID})
	if err != nil {
		t.Fatal(err)
	}
	sent, err := w.f.Issue.Start(context.Background(), issue.ID, "")
	if err != nil || sent.Session == nil {
		t.Fatalf("start: %+v %v", sent, err)
	}
	first := *sent.Session
	thread := testkit.Await(t, "the issue's thread", func() (protocol.Conversation, bool) {
		id := w.f.Channel.JobThread(first)
		if id == nil {
			return protocol.Conversation{}, false
		}
		c := protocol.ConversationOf(w.f.Core.State().Chat, *id)
		return ptr.Value(c), c != nil
	})
	if thread.SubjectKind == nil || *thread.SubjectKind != protocol.SubjectKindIssue || thread.SubjectID == nil || *thread.SubjectID != issue.ID {
		t.Fatalf("the thread hangs on the issue: %+v", thread)
	}
	in := func() []protocol.ChatMessage { return protocol.MessagesIn(w.f.Core.State().Chat, thread.ID) }
	reportsBy := func(session string) int {
		n := 0
		for _, m := range in() {
			if m.Kind == protocol.MessageKindReport && m.From == session {
				n++
			}
		}
		return n
	}
	testkit.Until(t, "the first session's report", func() bool { return reportsBy(first) == 1 })
	if _, _, err := w.f.Channel.Say("把输出改成中文", &thread.ID, ""); err != nil {
		t.Fatal(err)
	}
	testkit.Until(t, "the person's words wake the first session", func() bool { return reportsBy(first) == 2 })

	w.f.Session.Dismiss(first)
	testkit.Until(t, "cancelled", func() bool { i, e := w.f.Issue.Get(issue.ID); return e == nil && i.Closed != nil })
	kept, _, err := w.f.Channel.Say("先记一下：时区用东八区", &thread.ID, "")
	if err != nil {
		t.Fatal(err)
	}
	var woken string
	if err := w.f.DB.QueryRow(`select coalesce(group_concat(recipient_id || ':' || reason), '') from channel_delivery where message_id = ?`, kept.ID).Scan(&woken); err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, woken, "", "no session works the issue: the words are kept, no one is woken")

	second, err := w.f.Issue.Reopen(context.Background(), issue.ID, "接着做", "")
	if err != nil {
		t.Fatal(err)
	}
	testkit.Until(t, "the second session's report in the same thread", func() bool { return reportsBy(second) == 1 })
	if got := w.f.Channel.JobThread(second); got == nil || *got != thread.ID {
		t.Fatalf("the second session's thread: %v, want %s", got, thread.ID)
	}
	handed := slices.IndexFunc(in(), func(m protocol.ChatMessage) bool {
		return m.Kind == protocol.MessageKindDispatch && m.Session != nil && *m.Session == second
	})
	if handed < 0 || !strings.Contains(in()[handed].Text, "@"+second) || !strings.Contains(in()[handed].Text, "第 2 次") {
		t.Fatalf("the handover in the thread: %+v", in())
	}
	if _, _, err := w.f.Channel.Say("时区记得改", &thread.ID, ""); err != nil {
		t.Fatal(err)
	}
	testkit.Until(t, "the person's words wake the second session", func() bool { return reportsBy(second) == 2 })
	testkit.Eq(t, reportsBy(first), 2, "the first session, gone, is not woken again")

	var threads []string
	for _, c := range w.f.Core.State().Chat.Conversations {
		if c.SubjectKind != nil && *c.SubjectKind == protocol.SubjectKindIssue && c.SubjectID != nil && *c.SubjectID == issue.ID {
			threads = append(threads, c.ID)
		}
	}
	testkit.Eq(t, threads, []string{thread.ID}, "one thread for the issue")
}
