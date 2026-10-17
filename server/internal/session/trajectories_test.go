package session

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/core"
	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
	"vibevalley/pkg/x/clock"
	"vibevalley/pkg/x/ptr"
)

func sessionTrajectories(t *testing.T, home string, change ...func(*base.Config)) *trajectories {
	t.Helper()
	core := core.New(home)
	cfg := fixture.Config(home, home, "")
	for _, f := range change {
		f(&cfg)
	}
	tr, err := newTrajectories(cfg, core)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tr.OnStop(); core.Close() })
	return tr
}

func TestTrajectoryKeptAndListed(t *testing.T) {
	tr := sessionTrajectories(t, t.TempDir())
	j := tr.Open(protocol.TrajectoryHead{ID: "w1", Name: "老周", Agent: ptr.To("backend"), Job: ptr.To("加分页"), StartedAt: 1}, 0)
	j.Asked("加分页", nil)
	j.ToolStarted("c1", ToolStart{Text: "ls", Action: protocol.ToolActionRunCommand, Tool: "bash"}, nil)
	j.ToolEnded("c1", "a\nb", true, nil)
	tr.Open(protocol.TrajectoryHead{ID: "w2", Name: "小吴", Agent: ptr.To("tester"), StartedAt: 2}, 0)
	tr.Finish("w1", protocol.IssueCloseDismissed, nil)
	w1 := tr.Get("w1")
	if w1 == nil || w1.Head.EndedAt == nil {
		t.Fatalf("w1 ended: %+v", w1)
	}
	var kinds []string
	for _, s := range w1.Activities {
		out := ""
		if s.Output != nil {
			out = *s.Output
		}
		kinds = append(kinds, string(s.Kind)+":"+out)
	}
	testkit.Eq(t, kinds, []string{"prompt:", "action:a\nb"}, "steps")
	ids := func(heads []protocol.TrajectoryHead) []string {
		var out []string
		for _, h := range heads {
			out = append(out, h.ID)
		}
		return out
	}
	testkit.Eq(t, ids(tr.List("")), []string{"w2", "w1"}, "newest first")
	testkit.Eq(t, ids(tr.List("backend")), []string{"w1"}, "by agent")
	if tr.Get("../w1") != nil {
		t.Fatal("nothing read from outside the folder")
	}
	tr.Open(protocol.TrajectoryHead{ID: "w1", Name: "老周", Agent: ptr.To("backend"), StartedAt: 99}, 0)
	again := tr.Get("w1")
	testkit.Eq(t, again.Head.StartedAt, int64(1), "start kept")
	if again.Head.EndedAt != nil {
		t.Fatal("no longer ended")
	}
	testkit.Eq(t, len(again.Activities), 2, "steps kept")
}

func writeHead(t *testing.T, dir, id string, started, ended int64) {
	t.Helper()
	body, _ := json.Marshal(protocol.TrajectoryHead{ID: id, Name: id, StartedAt: started, EndedAt: &ended})
	if err := os.WriteFile(filepath.Join(dir, id+".head.json"), body, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestOldTrajectoriesLoseTheirSteps(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "activities")
	os.MkdirAll(dir, 0o755)
	long := clock.NowMs() - int64(base.Defaults().Session.TrajectoryDays+1)*protocol.DayMs
	writeHead(t, dir, "w1", long, long)
	os.WriteFile(filepath.Join(dir, "w1.json"), []byte(`[{"n":0,"at":0,"kind":"prompt","text":"老活"}]`), 0o644)
	writeHead(t, dir, "w2", clock.NowMs(), clock.NowMs())
	os.WriteFile(filepath.Join(dir, "w2.json"), []byte("[]"), 0o644)
	tr := sessionTrajectories(t, home)
	testkit.Eq(t, len(tr.List("")), 2, "both issues listed")
	old := tr.Get("w1")
	if old == nil || len(old.Activities) != 0 {
		t.Fatalf("the old one, without its steps: %+v", old)
	}
	entries, _ := os.ReadDir(dir)
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	testkit.Eq(t, names, []string{"w1.head.json", "w2.head.json", "w2.json"}, "files left")
}

func TestTrajectoryDaysZeroKeepsForGood(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "activities")
	os.MkdirAll(dir, 0o755)
	long := clock.NowMs() - 400*protocol.DayMs
	writeHead(t, dir, "w1", long, long)
	testkit.Eq(t, len(sessionTrajectories(t, home, func(c *base.Config) { c.Session.TrajectoryDays = 0 }).List("")), 1, "kept")
}

func TestReasoningRunsOn(t *testing.T) {
	j := sessionTrajectories(t, t.TempDir()).Open(protocol.TrajectoryHead{ID: "w1", Name: "老周", StartedAt: 1}, 0)
	j.Thought("先看", nil)
	j.Thought("路由", nil)
	j.Said("好", nil)
	j.Thought("再想想", nil)
	j.ToolStarted("c1", ToolStart{Text: "ls", Action: protocol.ToolActionRunCommand, Tool: "bash"}, nil)
	j.Thought("看完了", nil)
	var got []string
	for _, s := range j.Activities() {
		got = append(got, string(s.Kind)+":"+s.Text)
	}
	testkit.Eq(t, got, []string{"thought:先看路由", "response:好", "thought:再想想", "action:ls", "thought:看完了"}, "steps")
}

func TestSubAgentStepsGoUnderTheirCall(t *testing.T) {
	j := sessionTrajectories(t, t.TempDir()).Open(protocol.TrajectoryHead{ID: "w1", Name: "老周", StartedAt: 1}, 0)
	j.ToolStarted("task-1", ToolStart{Text: "派个帮手", Action: protocol.ToolActionOther, Tool: "Task"}, nil)
	j.Said("帮手先看看", From{"task-1"})
	j.ToolStarted("c1", ToolStart{Text: "ls", Action: protocol.ToolActionRunCommand, Tool: "bash"}, From{"task-1"})
	j.ToolStarted("c1", ToolStart{Text: "pwd", Action: protocol.ToolActionRunCommand, Tool: "bash"}, nil)
	j.ToolEnded("c1", "a.ts", true, From{"task-1"})
	j.Said("帮手看完了", From{"task-1"})
	j.ToolEnded("c1", "/work", true, nil)
	j.ToolEnded("task-1", "看完了", true, nil)
	j.Said("好", nil)
	j.Said("，就这样", From{"ghost"})
	var got []string
	for _, s := range j.Activities() {
		out, under := "", "-"
		if s.Output != nil {
			out = *s.Output
		}
		if s.Under != nil {
			under = fmt.Sprint(*s.Under)
		}
		got = append(got, fmt.Sprintf("%d %s %s %s %s", s.N, s.Kind, s.Text, out, under))
	}
	testkit.Eq(t, got, []string{
		"0 action 派个帮手 看完了 -",
		"1 response 帮手先看看  0",
		"2 action ls a.ts 0",
		"3 action pwd /work -",
		"4 response 帮手看完了  0",
		"5 response 好  -",
		"6 response ，就这样  -1",
	}, "steps")
}

func TestJournalSendsAndWrites(t *testing.T) {
	home := t.TempDir()
	core := core.New(home)
	defer core.Close()
	_, events, stop := core.Events()
	defer stop()
	tr, _ := newTrajectories(fixture.Config(home, "", ""), core)
	j := tr.Open(protocol.TrajectoryHead{ID: "w9", Name: "老周", StartedAt: 1}, 0)
	j.Said("好", nil)
	j.Said("的", nil)
	select {
	case e := <-events:
		step, ok := e.Value.(protocol.SideEventActivity)
		if !ok || step.ID != "w9" || step.Activity.Text != "好的" {
			t.Fatalf("one step, grown, sent once: %+v", e.Value)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the step was not sent")
	}
	tr.Finish("w9", protocol.IssueCloseDismissed, nil)
	testkit.Eq(t, len(readJournal(filepath.Join(home, "activities", "w9.json"))), 1, "written")
}
