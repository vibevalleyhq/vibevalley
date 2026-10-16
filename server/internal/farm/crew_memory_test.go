package farm

import (
	"context"
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
	"vibevalley/pkg/smith/oar"
)

type crewPrompts struct {
	mu     sync.Mutex
	inputs []string
	taken  int
}

func (p *crewPrompts) next(t *testing.T) string {
	t.Helper()
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.taken == len(p.inputs) {
		t.Fatal("no session was prompted")
	}
	p.taken++
	return p.inputs[p.taken-1]
}

type crewPrompted struct {
	oar.Session
	prompts *crewPrompts
}

func (s crewPrompted) Prompt(ctx context.Context, input string, options oar.InputOptions) (oar.ControlOutcome, error) {
	s.prompts.mu.Lock()
	s.prompts.inputs = append(s.prompts.inputs, input)
	s.prompts.mu.Unlock()
	return s.Session.Prompt(ctx, input, options)
}

// Called before anyone is hired, as crew_reach_test.go swaps the registry.
func crewRecordPrompts(t *testing.T, w *crewWorld) *crewPrompts {
	t.Helper()
	p := &crewPrompts{}
	pi := crewScripted()
	open := pi.Session
	pi.Session = func(ctx context.Context, installation oar.AvailableInstallation, options oar.SessionOptions) (oar.Session, error) {
		s, err := open(ctx, installation, options)
		if err != nil {
			return nil, err
		}
		return crewPrompted{Session: s, prompts: p}, nil
	}
	registry, err := oar.NewRuntimeRegistry(pi)
	if err != nil {
		t.Fatal(err)
	}
	w.f.Runtimes.Registry = registry
	return p
}

func crewReminded(t *testing.T, input string) ([]string, string) {
	t.Helper()
	parts := strings.Split(input, runs.JobBreak)
	if len(parts) == 1 {
		return nil, input
	}
	lines := strings.Split(parts[0], "\n")
	if len(parts) != 2 || !strings.HasPrefix(lines[0], runs.RecallHead) {
		t.Fatalf("on top of the job is not just what it was reminded of: %q", input)
	}
	return lines[1:], parts[1]
}

// A finished turn is kept on a goroutine of its own.
func crewKept(t *testing.T, w *crewWorld, agent string, n int) []protocol.Memory {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for {
		kept := w.f.Memories.List(agent)
		if len(kept) >= n {
			return kept
		}
		if time.Now().After(deadline) {
			t.Fatalf("%s remembers %d, not %d, after 10 s: %+v", agent, len(kept), n, kept)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestCrewMemoryKeptAndRecalled(t *testing.T) {
	home, work := crewDirs(t)
	w := crewOpen(t, home, work)
	prompts := crewRecordPrompts(t, w)
	ctx := context.Background()
	scribe, drafter := farmtest.Lab(t), farmtest.Lab(t)
	scribe.ID, scribe.Name = "scribe", "记录员"
	drafter.ID, drafter.Name = "drafter", "起草员"

	first := crewHired(t, w.f.Dispatch.Hire(ctx, scribe, "写上班打卡，记一笔", "memo", base.HireOptions{}))
	farmtest.Eq(t, prompts.next(t), "写上班打卡，记一笔", "nothing on top of the first job")
	report := w.nextReport(t)
	farmtest.Eq(t, report.outcome, protocol.OutcomeCompleted, "outcome")
	farmtest.Match(t, report.text, `(?s)｜人设：.*「记住：」`, "the farm's rules ask for notes")
	farmtest.Match(t, report.text, `\n记住：这个项目用 pnpm test 跑测试\n记住（所有项目）：提交信息写中文$`, "the notes")

	kept := crewKept(t, w, scribe.ID, 3)
	i := slices.IndexFunc(kept, func(m protocol.Memory) bool { return m.Kind == protocol.MemoryKindJob })
	if len(kept) != 3 || i < 0 {
		t.Fatalf("kept: %+v", kept)
	}
	job := kept[i]
	farmtest.Match(t, job.Text, `^写上班打卡，记一笔 → `, "the job as its agent remembers it")
	type row struct{ kind, text, project, helper string }
	rows := map[row]bool{}
	for _, m := range kept {
		r := row{kind: string(m.Kind), text: m.Text, project: "所有项目"}
		if m.Project != nil {
			r.project = *m.Project
		}
		if m.Helper != nil {
			r.helper = *m.Helper
		}
		rows[r] = true
	}
	farmtest.Eq(t, rows, map[row]bool{
		{"note", "这个项目用 pnpm test 跑测试", "memo", first.ID}: true,
		{"note", "提交信息写中文", "所有项目", first.ID}:             true,
		{"job", job.Text, "memo", first.ID}:               true,
	}, "kept for the agent")
	farmtest.Eq(t, crewKept(t, w, first.ID, 0), []protocol.Memory{}, "nothing kept for the helper")

	w.f.Crew.Dismiss(first.ID)
	second := crewHired(t, w.f.Dispatch.Hire(ctx, scribe, "再加一个下班打卡", "memo", base.HireOptions{}))
	recalled, asked := crewReminded(t, prompts.next(t))
	farmtest.Eq(t, asked, "再加一个下班打卡", "the job under the recall block")
	farmtest.Eq(t, slices.Sorted(slices.Values(recalled)), slices.Sorted(slices.Values([]string{
		"- （这个项目）这个项目用 pnpm test 跑测试",
		"- （所有项目）提交信息写中文",
		"- 做过（这个项目）：" + job.Text,
	})), "recalled in the same project")
	w.nextReport(t)
	steps, _ := w.f.Crew.Steps(second.ID)
	if len(steps) < 2 {
		t.Fatalf("steps: %+v", steps)
	}
	farmtest.Eq(t, []any{steps[0].Kind, steps[0].Text, steps[1].Kind, steps[1].Text},
		[]any{protocol.StepKindAsked, "再加一个下班打卡", protocol.StepKindRecalled, strings.Join(recalled, "\n")}, "its steps")

	memo := "memo"
	if _, err := w.f.Memories.Write(scribe.ID, "下班打卡也要有测试", memo); err != nil {
		t.Fatal(err)
	}
	farmtest.Eq(t, w.f.Crew.Deliver(second.ID, "顺手把下班打卡的测试也补上").Kind, "turn", "a new turn")
	recalled, asked = crewReminded(t, prompts.next(t))
	farmtest.Eq(t, []any{recalled, asked}, []any{[]string{"- （这个项目）下班打卡也要有测试"}, "顺手把下班打卡的测试也补上"}, "only what is new to its session")
	w.nextReport(t)

	crewHired(t, w.f.Dispatch.Hire(ctx, scribe, "写一篇博客", "memo-blog", base.HireOptions{}))
	recalled, asked = crewReminded(t, prompts.next(t))
	farmtest.Eq(t, []any{recalled, asked}, []any{[]string{"- （所有项目）提交信息写中文"}, "写一篇博客"}, "recalled in another project")
	w.nextReport(t)

	other := crewHired(t, w.f.Dispatch.Hire(ctx, drafter, "跑一遍 pnpm test 测试，看看上班打卡", "memo", base.HireOptions{}))
	farmtest.Eq(t, prompts.next(t), "跑一遍 pnpm test 测试，看看上班打卡", "nothing on top for another agent")
	w.nextReport(t)
	theirs := crewKept(t, w, drafter.ID, 1)
	if len(theirs) != 1 || theirs[0].Kind != protocol.MemoryKindJob || theirs[0].Helper == nil || *theirs[0].Helper != other.ID {
		t.Fatalf("the other agent keeps: %+v", theirs)
	}
	w.f.Crew.DismissAll()
}

func TestCrewMemoryRecalledOnceAcrossARestart(t *testing.T) {
	home, work := crewDirs(t)
	// A file, so they outlive the restart as they do in real use.
	db := filepath.Join(home, "farm.db")
	first := crewOpenAt(t, home, work, db)
	prompts := crewRecordPrompts(t, first)
	ctx := context.Background()
	scribe := farmtest.Lab(t)
	scribe.ID, scribe.Name = "scribe", "记录员"
	// Waking after the restart reads the agent from the store, as in real use.
	first.f.Store.SaveAgent(scribe)

	noted := crewHired(t, first.f.Dispatch.Hire(ctx, scribe, "写上班打卡，记一笔", "memo", base.HireOptions{}))
	prompts.next(t)
	first.nextReport(t)
	crewKept(t, first, scribe.ID, 3)
	first.f.Crew.Dismiss(noted.ID)
	helper := crewHired(t, first.f.Dispatch.Hire(ctx, scribe, "再加一个下班打卡", "memo", base.HireOptions{}))
	recalled, _ := crewReminded(t, prompts.next(t))
	farmtest.Eq(t, len(recalled), 3, "reminded of all three when hired")
	first.nextReport(t)
	first.stop()

	again := crewOpenAt(t, home, work, db)
	prompts = crewRecordPrompts(t, again)
	crewKept(t, again, scribe.ID, 3)
	farmtest.Eq(t, again.f.Crew.Deliver(helper.ID, "顺手把下班打卡的测试也补上").Kind, "turn", "woken after the restart")
	farmtest.Eq(t, prompts.next(t), "顺手把下班打卡的测试也补上", "its resumed session is not reminded again")
	again.nextReport(t)
}
