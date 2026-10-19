package workspace

import (
	"context"
	"fmt"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"vibevalley/internal/memory"
	"vibevalley/internal/protocol"
	"vibevalley/internal/session"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/smith/oar"
)

type prompts struct {
	mu     sync.Mutex
	inputs []string
	taken  int
}

func (p *prompts) next(t *testing.T) string {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.taken == len(p.inputs) {
		t.Fatal("no session was prompted")
	}
	p.taken++
	return p.inputs[p.taken-1]
}

type prompted struct {
	oar.Session
	prompts *prompts
}

func (s prompted) Prompt(ctx context.Context, input string, options oar.InputOptions) (oar.ControlOutcome, error) {
	s.prompts.mu.Lock()
	s.prompts.inputs = append(s.prompts.inputs, input)
	s.prompts.mu.Unlock()
	return s.Session.Prompt(ctx, input, options)
}

// Called before anyone is hired, as reach_test.go swaps the registry.
func recordPrompts(t *testing.T, w *testWorld) *prompts {
	t.Helper()
	p := &prompts{}
	pi := scripted()
	open := pi.Session
	pi.Session = func(ctx context.Context, installation oar.AvailableInstallation, options oar.SessionOptions) (oar.Session, error) {
		s, err := open(ctx, installation, options)
		if err != nil {
			return nil, err
		}
		return prompted{Session: s, prompts: p}, nil
	}
	registry, err := oar.NewRuntimeRegistry(pi)
	if err != nil {
		t.Fatal(err)
	}
	w.f.Runtime.UseRegistry(registry)
	return p
}

func reminded(t *testing.T, input string) ([]string, string) {
	t.Helper()
	parts := strings.Split(input, session.JobBreak)
	if len(parts) == 1 {
		return nil, input
	}
	lines := strings.Split(parts[0], "\n")
	if len(parts) != 2 || !strings.HasPrefix(lines[0], session.RecallHead) {
		t.Fatalf("on top of the job is not just what it was reminded of: %q", input)
	}
	return lines[1:], parts[1]
}

// A finished turn is kept on a goroutine of its own.
func workspaceKept(t *testing.T, w *testWorld, agent string, n int) []protocol.Memory {
	t.Helper()
	return testkit.Await(t, fmt.Sprintf("%s remembers %d", agent, n), func() ([]protocol.Memory, bool) {
		kept := w.f.Memory.List(agent)
		return kept, len(kept) >= n
	})
}

func TestMemoryKeptAndRecalled(t *testing.T) {
	home, work := dirs(t)
	w := openWorld(t, home, work)
	prompts := recordPrompts(t, w)
	ctx := context.Background()
	scribe, drafter := fixture.Lab(t), fixture.Lab(t)
	scribe.ID, scribe.Name = "scribe", "记录员"
	drafter.ID, drafter.Name = "drafter", "起草员"

	first := mustHire(t, w.f.Issue.Hire(ctx, scribe, "写上班打卡，记一笔", "memo", session.HireOptions{}))
	testkit.Eq(t, prompts.next(t), "写上班打卡，记一笔", "nothing on top of the first job")
	report := w.nextReport(t)
	testkit.Eq(t, report.outcome, protocol.OutcomeCompleted, "outcome")
	testkit.Match(t, report.text, `(?s)｜人设：.*「记住：」`, "the farm's rules ask for notes")
	testkit.Match(t, report.text, `\n记住：这个项目用 pnpm test 跑测试\n记住（所有项目）：提交信息写中文$`, "the notes")

	kept := workspaceKept(t, w, scribe.ID, 3)
	i := slices.IndexFunc(kept, func(m protocol.Memory) bool { return m.Kind == protocol.MemoryKindIssue })
	if len(kept) != 3 || i < 0 {
		t.Fatalf("kept: %+v", kept)
	}
	job := kept[i]
	testkit.Match(t, job.Text, `^写上班打卡，记一笔 → `, "the job as its agent remembers it")
	type row struct{ kind, text, project, session string }
	rows := map[row]bool{}
	for _, m := range kept {
		r := row{kind: string(m.Kind), text: m.Text, project: "所有项目"}
		if m.Project != nil {
			r.project = *m.Project
		}
		if m.Session != nil {
			r.session = *m.Session
		}
		rows[r] = true
	}
	testkit.Eq(t, rows, map[row]bool{
		{"note", "这个项目用 pnpm test 跑测试", "memo", first.ID}: true,
		{"note", "提交信息写中文", "所有项目", first.ID}:             true,
		{"issue", job.Text, "memo", first.ID}:             true,
	}, "kept for the agent")
	testkit.Eq(t, workspaceKept(t, w, first.ID, 0), []protocol.Memory{}, "nothing kept for the session")

	w.f.Session.Dismiss(first.ID)
	second := mustHire(t, w.f.Issue.Hire(ctx, scribe, "再加一个下班打卡", "memo", session.HireOptions{}))
	recalled, asked := reminded(t, prompts.next(t))
	testkit.Eq(t, asked, "再加一个下班打卡", "the job under the recall block")
	testkit.Eq(t, slices.Sorted(slices.Values(recalled)), slices.Sorted(slices.Values([]string{
		"- （这个项目）这个项目用 pnpm test 跑测试",
		"- （所有项目）提交信息写中文",
		"- 做过（这个项目）：" + job.Text,
	})), "recalled in the same project")
	w.nextReport(t)
	steps := w.f.Session.Events(second.ID, "")
	if len(steps) < 3 || steps[0].Type != protocol.SessionEventTypeRunStart {
		t.Fatalf("steps: %+v", steps)
	}
	steps = steps[1:]
	testkit.Eq(t, []any{steps[0].Type, steps[0].Text, steps[1].Type, steps[1].Text},
		[]any{protocol.SessionEventTypeUserMessage, "再加一个下班打卡", protocol.SessionEventTypeMemoryRecalled, strings.Join(recalled, "\n")}, "its steps")

	memo := "memo"
	if _, err := w.f.Memory.Write(memory.Note{Agent: scribe.ID, Text: "下班打卡也要有测试", Project: memo, By: protocol.MemoryAuthorOwner}); err != nil {
		t.Fatal(err)
	}
	testkit.Eq(t, w.f.Session.Deliver(second.ID, "顺手把下班打卡的测试也补上", protocol.RunTrigger{Kind: protocol.RunTriggerKindComment}).Kind, "run", "a new run")
	recalled, asked = reminded(t, prompts.next(t))
	testkit.Eq(t, []any{recalled, asked}, []any{[]string{"- （这个项目）下班打卡也要有测试"}, "顺手把下班打卡的测试也补上"}, "only what is new to its session")
	w.nextReport(t)

	mustHire(t, w.f.Issue.Hire(ctx, scribe, "写一篇博客", "memo-blog", session.HireOptions{}))
	recalled, asked = reminded(t, prompts.next(t))
	testkit.Eq(t, []any{recalled, asked}, []any{[]string{"- （所有项目）提交信息写中文"}, "写一篇博客"}, "recalled in another project")
	w.nextReport(t)

	other := mustHire(t, w.f.Issue.Hire(ctx, drafter, "跑一遍 pnpm test 测试，看看上班打卡", "memo", session.HireOptions{}))
	testkit.Eq(t, prompts.next(t), "跑一遍 pnpm test 测试，看看上班打卡", "nothing on top for another agent")
	w.nextReport(t)
	theirs := workspaceKept(t, w, drafter.ID, 1)
	if len(theirs) != 1 || theirs[0].Kind != protocol.MemoryKindIssue || theirs[0].Session == nil || *theirs[0].Session != other.ID {
		t.Fatalf("the other agent keeps: %+v", theirs)
	}
	for _, h := range w.f.Core.State().Sessions {
		w.f.Session.Dismiss(h.ID)
	}
}

func TestMemoryRecalledOnceAcrossARestart(t *testing.T) {
	home, work := dirs(t)
	// A file, so they outlive the restart as they do in real use.
	db := filepath.Join(home, "vibevalley.db")
	first := openWorldAt(t, home, work, db)
	prompts := recordPrompts(t, first)
	ctx := context.Background()
	scribe := fixture.Lab(t)
	scribe.ID, scribe.Name = "scribe", "记录员"
	// Waking after the restart reads the agent from the store, as in real use.
	first.f.Agent.SaveAgent(scribe)

	noted := mustHire(t, first.f.Issue.Hire(ctx, scribe, "写上班打卡，记一笔", "memo", session.HireOptions{}))
	prompts.next(t)
	first.nextReport(t)
	workspaceKept(t, first, scribe.ID, 3)
	first.f.Session.Dismiss(noted.ID)
	session := mustHire(t, first.f.Issue.Hire(ctx, scribe, "再加一个下班打卡", "memo", session.HireOptions{}))
	recalled, _ := reminded(t, prompts.next(t))
	testkit.Eq(t, len(recalled), 3, "reminded of all three when hired")
	first.nextReport(t)
	first.stop()

	again := openWorldAt(t, home, work, db)
	prompts = recordPrompts(t, again)
	workspaceKept(t, again, scribe.ID, 3)
	testkit.Eq(t, again.f.Session.Deliver(session.ID, "顺手把下班打卡的测试也补上", protocol.RunTrigger{Kind: protocol.RunTriggerKindComment}).Kind, "run", "woken after the restart")
	testkit.Eq(t, prompts.next(t), "顺手把下班打卡的测试也补上", "its resumed session is not reminded again")
	again.nextReport(t)
}
