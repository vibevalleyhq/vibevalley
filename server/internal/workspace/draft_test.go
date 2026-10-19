package workspace

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/x/ptr"
)

func drafting(w *testWorld) bool {
	return slices.ContainsFunc(w.f.Core.State().Sessions, func(h protocol.Session) bool { return h.Draft })
}

// Nothing a draft did stays: its worktree is gone or clean, and its branch, if any, has nothing main does not.
func draftLeftNothing(t *testing.T, work string, issue protocol.Issue) {
	t.Helper()
	project := filepath.Join(work, "projects", *issue.Project)
	tree := filepath.Join(work, "worktrees", fmt.Sprintf("%s.%d", *issue.Project, issue.Number))
	if _, err := os.Stat(tree); err == nil {
		testkit.Eq(t, testkit.Git(t, tree, "status", "--porcelain"), "", "the worktree is clean")
	}
	branch := fmt.Sprintf("vibevalley/issue-%d", issue.Number)
	if exec.Command("git", "-C", project, "show-ref", "--verify", "--quiet", "refs/heads/"+branch).Run() == nil {
		testkit.Eq(t, testkit.Git(t, project, "rev-list", "--count", "main.."+branch), "0", "no commit on its branch")
	}
}

// The plus makes an unsent issue; a session drafts it to the issue's format and leaves, the issue still in the backlog.
// It asks; the owner's answer makes a second draft over the first; sent out, its session is told the criteria.
func TestAnIssueIsDraftedBeforeItIsSent(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	lab := fixture.Lab(t)
	w.f.Agent.SaveAgent(lab)
	ctx := context.Background()
	// It names no one: whoever was last sent to work in the project drafts it.
	before := mustHire(t, w.f.Issue.Hire(ctx, lab, "看看项目", "board", session.HireOptions{}))
	w.nextReport(t)
	w.f.Session.Dismiss(before.ID)
	issue, err := w.f.Issue.Add(protocol.IssueRequest{Title: "新工单", Project: ptr.To("board")})
	if err != nil {
		t.Fatal(err)
	}
	got, err := w.f.Issue.Draft(ctx, issue.ID, "慢慢看：看板拖卡还在调旧接口", "")
	if err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, []any{got.Status, got.Title, *got.Assignee, len(got.Sessions)}, []any{protocol.IssueStatusBacklog, "慢慢看：看板拖卡还在调旧接口", lab.ID, 0},
		"the owner's word is its title, the drafter its assignee, still unsent")
	if got.Drafting == nil || got.Drafting.Name != lab.Name {
		t.Fatalf("drafting: %+v", got.Drafting)
	}
	testkit.Eq(t, got.Moves, []protocol.IssueStatus{protocol.IssueStatusCanceled}, "no start while it drafts")
	var refused protocol.Refused
	if _, err := w.f.Issue.SetStatus(ctx, issue.ID, protocol.IssueStatusTodo, "", ""); !errors.As(err, &refused) {
		t.Fatalf("started while drafting: %v", err)
	}
	if _, err := w.f.Issue.Draft(ctx, issue.ID, "再来", ""); !errors.As(err, &refused) {
		t.Fatalf("two drafts at once: %v", err)
	}

	issue = testkit.Await(t, "the draft written into the issue", func() (protocol.Issue, bool) {
		got, _ := w.f.Issue.Get(issue.ID)
		return got, got.Title == "看板拖卡改用 issue.status" && got.Drafting == nil
	})
	testkit.Eq(t, issue.Description, "为什么：\n看板还在调旧接口\n\n要做的：\n- 改 board.dart\n\n可能涉及：\n- board.dart", "its description")
	testkit.Eq(t, issue.Criteria, []string{"拖到待办就开工"}, "its criteria")
	testkit.Eq(t, issue.Asks, []string{"用 8787 还是 8797？"}, "what it asks")
	testkit.Eq(t, []any{issue.Status, len(issue.Sessions)}, []any{protocol.IssueStatusBacklog, 0}, "still in the backlog, nobody's work yet")
	testkit.Until(t, "the drafter left", func() bool { return !drafting(w) })
	draftLeftNothing(t, work, issue)
	runs, err := w.f.Session.Runs(issue.ID)
	if err != nil || len(runs) != 1 || runs[0].TriggeredBy.Kind != protocol.RunTriggerKindDraft {
		t.Fatalf("its draft is a run on the issue: %+v %v", runs, err)
	}
	inState := func() protocol.Issue {
		i := slices.IndexFunc(w.f.Core.State().Issues, func(x protocol.Issue) bool { return x.ID == issue.ID })
		return w.f.Core.State().Issues[i]
	}
	testkit.Until(t, "the core state has its draft", func() bool {
		x := inState()
		return x.Drafting == nil && slices.Contains(x.Moves, protocol.IssueStatusTodo) && len(x.Criteria) == 1
	})

	if _, err := w.f.Issue.Draft(ctx, issue.ID, "用 8797", ""); err != nil {
		t.Fatal(err)
	}
	issue = testkit.Await(t, "the second draft over the first", func() (protocol.Issue, bool) {
		got, _ := w.f.Issue.Get(issue.ID)
		return got, got.Title == "看板拖卡改用 8797 端口" && got.Drafting == nil
	})
	testkit.Eq(t, []any{issue.Criteria, len(issue.Asks)}, []any{[]string{"拖到待办就开工", "端口是 8797"}, 0}, "answered: new criteria, nothing asked")
	testkit.Until(t, "the second drafter left", func() bool { return !drafting(w) })

	if issue, err = w.f.Issue.SetStatus(ctx, issue.ID, protocol.IssueStatusTodo, "", ""); err != nil {
		t.Fatal(err)
	}
	if len(issue.Sessions) != 1 {
		t.Fatalf("sent out: %+v", issue.Sessions)
	}
	brief := w.f.Session.Get(issue.Sessions[0]).Brief
	for _, want := range []string{"看板拖卡改用 8797 端口", "验收标准", "- 拖到待办就开工\n- 端口是 8797"} {
		if !strings.Contains(brief, want) {
			t.Errorf("its job lacks %q: %s", want, brief)
		}
	}
}

// A drafter that changes files and commits leaves the worktree as main has it; canceling an issue mid-draft sends the
// drafter home and leaves no worktree or branch.
func TestADraftLeavesNothingBehind(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	lab := fixture.Lab(t)
	w.f.Agent.SaveAgent(lab)
	ctx := context.Background()
	issue, _ := w.f.Issue.Add(protocol.IssueRequest{Title: "新工单", Project: ptr.To("board"), Assignee: &lab.ID})
	if _, err := w.f.Issue.Draft(ctx, issue.ID, "顺手提交：看板拖卡", ""); err != nil {
		t.Fatal(err)
	}
	issue = testkit.Await(t, "drafted", func() (protocol.Issue, bool) {
		got, _ := w.f.Issue.Get(issue.ID)
		return got, len(got.Criteria) > 0 && got.Drafting == nil
	})
	testkit.Until(t, "the drafter left", func() bool { return !drafting(w) })
	draftLeftNothing(t, work, issue)
	project := filepath.Join(work, "projects", "board")
	if strings.Contains(testkit.Git(t, project, "log", "--format=%s", "--all"), "起草时不该有的提交") {
		t.Fatal("the draft's commit is still on some branch")
	}

	canceled, _ := w.f.Issue.Add(protocol.IssueRequest{Title: "新工单", Project: ptr.To("board"), Assignee: &lab.ID})
	if _, err := w.f.Issue.Draft(ctx, canceled.ID, "慢慢看：取消它", ""); err != nil {
		t.Fatal(err)
	}
	tree := filepath.Join(work, "worktrees", fmt.Sprintf("board.%d", canceled.Number))
	if _, err := os.Stat(tree); err != nil {
		t.Fatalf("the draft works in the issue's worktree: %v", err)
	}
	got, err := w.f.Issue.SetStatus(ctx, canceled.ID, protocol.IssueStatusCanceled, "", "")
	if err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, got.Status, protocol.IssueStatusCanceled, "canceled")
	testkit.Until(t, "the drafter went home", func() bool { return !drafting(w) })
	if _, err := os.Stat(tree); !os.IsNotExist(err) {
		t.Fatalf("its worktree is gone: %v", err)
	}
	if exec.Command("git", "-C", project, "show-ref", "--verify", "--quiet", fmt.Sprintf("refs/heads/vibevalley/issue-%d", canceled.Number)).Run() == nil {
		t.Fatal("its empty branch is gone")
	}
}

// A draft that does not read leaves the issue as it was and says so in the issue's thread.
func TestAnUnreadableDraftChangesNothing(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	ctx, cancel := context.WithCancel(context.Background())
	if err := w.f.Channel.OnStart(ctx); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { cancel(); w.f.Channel.OnStop() })
	lab := fixture.Lab(t)
	w.f.Agent.SaveAgent(lab)
	issue, _ := w.f.Issue.Add(protocol.IssueRequest{Title: "新工单", Project: ptr.To("board"), Assignee: &lab.ID})
	// Slow enough for the thread to open before it hands back, as any real draft is.
	before, err := w.f.Issue.Draft(context.Background(), issue.ID, "慢慢乱写一通", "")
	if err != nil {
		t.Fatal(err)
	}
	testkit.Until(t, "the drafter left", func() bool { return !drafting(w) })
	thread := testkit.Await(t, "the issue's thread", func() (string, bool) {
		chat := w.f.Core.State().Chat
		if chat == nil {
			return "", false
		}
		for _, c := range chat.Conversations {
			if c.SubjectID != nil && *c.SubjectID == issue.ID {
				return c.ID, true
			}
		}
		return "", false
	})
	testkit.Until(t, "the thread says the draft did not read", func() bool {
		return slices.ContainsFunc(protocol.MessagesIn(w.f.Core.State().Chat, thread), func(m protocol.ChatMessage) bool {
			return m.Kind == protocol.MessageKindNotice && strings.Contains(m.Text, "读不出来")
		})
	})
	after, _ := w.f.Issue.Get(issue.ID)
	testkit.Eq(t, []any{after.Title, after.Description, after.Criteria, after.Status}, []any{before.Title, before.Description, before.Criteria, protocol.IssueStatusBacklog}, "unchanged")
}
