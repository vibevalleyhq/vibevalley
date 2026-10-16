package runs

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/farmtest"
	"vibevalley/internal/protocol"
)

func crewTrajectories(t *testing.T, home string) *Trajectories {
	t.Helper()
	site := base.NewSite(home)
	tr, err := newTrajectories(base.Config{Home: home, WorkRoot: home}, site)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { tr.OnStop(); site.Close() })
	return tr
}

func TestCrewTrajectoryKeptAndListed(t *testing.T) {
	tr := crewTrajectories(t, t.TempDir())
	j := tr.Open(protocol.TrajectoryHead{ID: "w1", Name: "老周", Agent: farmtest.Ptr("backend"), Job: farmtest.Ptr("加分页"), StartedAt: 1}, 0)
	j.Asked("加分页", nil)
	j.ToolStarted("c1", base.ToolStart{Text: "ls", Action: protocol.ToolActionRunCommand, Tool: "bash"}, nil)
	j.ToolEnded("c1", "a\nb", true, nil)
	tr.Open(protocol.TrajectoryHead{ID: "w2", Name: "小吴", Agent: farmtest.Ptr("tester"), StartedAt: 2}, 0)
	tr.Finish("w1", protocol.IssueCloseDismissed, nil)
	w1 := tr.Get("w1")
	if w1 == nil || w1.Head.EndedAt == nil {
		t.Fatalf("w1 ended: %+v", w1)
	}
	var kinds []string
	for _, s := range w1.Steps {
		out := ""
		if s.Output != nil {
			out = *s.Output
		}
		kinds = append(kinds, string(s.Kind)+":"+out)
	}
	farmtest.Eq(t, kinds, []string{"asked:", "tool:a\nb"}, "steps")
	ids := func(heads []protocol.TrajectoryHead) []string {
		var out []string
		for _, h := range heads {
			out = append(out, h.ID)
		}
		return out
	}
	farmtest.Eq(t, ids(tr.List("")), []string{"w2", "w1"}, "newest first")
	farmtest.Eq(t, ids(tr.List("backend")), []string{"w1"}, "by agent")
	if tr.Get("../w1") != nil {
		t.Fatal("nothing read from outside the folder")
	}
	tr.Open(protocol.TrajectoryHead{ID: "w1", Name: "老周", Agent: farmtest.Ptr("backend"), StartedAt: 99}, 0)
	again := tr.Get("w1")
	farmtest.Eq(t, again.Head.StartedAt, int64(1), "start kept")
	if again.Head.EndedAt != nil {
		t.Fatal("no longer ended")
	}
	farmtest.Eq(t, len(again.Steps), 2, "steps kept")
}

func crewWriteHead(t *testing.T, dir, id string, started, ended int64) {
	t.Helper()
	body, _ := json.Marshal(protocol.TrajectoryHead{ID: id, Name: id, StartedAt: started, EndedAt: &ended})
	if err := os.WriteFile(filepath.Join(dir, id+".head.json"), body, 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestCrewOldTrajectoriesLoseTheirSteps(t *testing.T) {
	home := t.TempDir()
	dir := filepath.Join(home, "steps")
	os.MkdirAll(dir, 0o755)
	long := base.NowMs() - (crewKeepDays+1)*base.DayMs
	crewWriteHead(t, dir, "w1", long, long)
	os.WriteFile(filepath.Join(dir, "w1.json"), []byte(`[{"n":0,"at":0,"kind":"asked","text":"老活"}]`), 0o644)
	crewWriteHead(t, dir, "w2", base.NowMs(), base.NowMs())
	os.WriteFile(filepath.Join(dir, "w2.json"), []byte("[]"), 0o644)
	tr := crewTrajectories(t, home)
	farmtest.Eq(t, len(tr.List("")), 2, "both issues listed")
	old := tr.Get("w1")
	if old == nil || len(old.Steps) != 0 {
		t.Fatalf("the old one, without its steps: %+v", old)
	}
	entries, _ := os.ReadDir(dir)
	var names []string
	for _, e := range entries {
		names = append(names, e.Name())
	}
	farmtest.Eq(t, names, []string{"w1.head.json", "w2.head.json", "w2.json"}, "files left")
}

func TestCrewTrajectoryDaysZeroKeepsForGood(t *testing.T) {
	t.Setenv("VIBEVALLEY_TRAJECTORY_DAYS", "0")
	home := t.TempDir()
	dir := filepath.Join(home, "steps")
	os.MkdirAll(dir, 0o755)
	long := base.NowMs() - 400*base.DayMs
	crewWriteHead(t, dir, "w1", long, long)
	farmtest.Eq(t, len(crewTrajectories(t, home).List("")), 1, "kept")
}

func TestCrewReasoningRunsOn(t *testing.T) {
	j := crewTrajectories(t, t.TempDir()).Open(protocol.TrajectoryHead{ID: "w1", Name: "老周", StartedAt: 1}, 0)
	j.Thought("先看", nil)
	j.Thought("路由", nil)
	j.Said("好", nil)
	j.Thought("再想想", nil)
	j.ToolStarted("c1", base.ToolStart{Text: "ls", Action: protocol.ToolActionRunCommand, Tool: "bash"}, nil)
	j.Thought("看完了", nil)
	var got []string
	for _, s := range j.Steps() {
		got = append(got, string(s.Kind)+":"+s.Text)
	}
	farmtest.Eq(t, got, []string{"thought:先看路由", "said:好", "thought:再想想", "tool:ls", "thought:看完了"}, "steps")
}

func TestCrewSubAgentStepsGoUnderTheirCall(t *testing.T) {
	j := crewTrajectories(t, t.TempDir()).Open(protocol.TrajectoryHead{ID: "w1", Name: "老周", StartedAt: 1}, 0)
	j.ToolStarted("task-1", base.ToolStart{Text: "派个帮手", Action: protocol.ToolActionOther, Tool: "Task"}, nil)
	j.Said("帮手先看看", base.From{"task-1"})
	j.ToolStarted("c1", base.ToolStart{Text: "ls", Action: protocol.ToolActionRunCommand, Tool: "bash"}, base.From{"task-1"})
	j.ToolStarted("c1", base.ToolStart{Text: "pwd", Action: protocol.ToolActionRunCommand, Tool: "bash"}, nil)
	j.ToolEnded("c1", "a.ts", true, base.From{"task-1"})
	j.Said("帮手看完了", base.From{"task-1"})
	j.ToolEnded("c1", "/work", true, nil)
	j.ToolEnded("task-1", "看完了", true, nil)
	j.Said("好", nil)
	j.Said("，就这样", base.From{"ghost"})
	var got []string
	for _, s := range j.Steps() {
		out, under := "", "-"
		if s.Output != nil {
			out = *s.Output
		}
		if s.Under != nil {
			under = fmt.Sprint(*s.Under)
		}
		got = append(got, fmt.Sprintf("%d %s %s %s %s", s.N, s.Kind, s.Text, out, under))
	}
	farmtest.Eq(t, got, []string{
		"0 tool 派个帮手 看完了 -",
		"1 said 帮手先看看  0",
		"2 tool ls a.ts 0",
		"3 tool pwd /work -",
		"4 said 帮手看完了  0",
		"5 said 好  -",
		"6 said ，就这样  -1",
	}, "steps")
}

func TestCrewJournalSendsAndWrites(t *testing.T) {
	home := t.TempDir()
	site := base.NewSite(home)
	defer site.Close()
	_, events, stop := site.Events()
	defer stop()
	tr, _ := newTrajectories(base.Config{Home: home}, site)
	j := tr.Open(protocol.TrajectoryHead{ID: "w9", Name: "老周", StartedAt: 1}, 0)
	j.Said("好", nil)
	j.Said("的", nil)
	select {
	case e := <-events:
		step, ok := e.Value.(protocol.SiteEventStep)
		if !ok || step.ID != "w9" || step.Step.Text != "好的" {
			t.Fatalf("one step, grown, sent once: %+v", e.Value)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the step was not sent")
	}
	tr.Finish("w9", protocol.IssueCloseDismissed, nil)
	farmtest.Eq(t, len(crewReadJournal(filepath.Join(home, "steps", "w9.json"))), 1, "written")
}
