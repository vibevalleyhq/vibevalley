package session

import (
	"fmt"
	"path/filepath"
	"testing"
	"time"

	"vibevalley/internal/base"
	"vibevalley/internal/core"
	"vibevalley/internal/protocol"
	"vibevalley/internal/testkit"
	"vibevalley/internal/testkit/fixture"
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

// A session's log is kept as it grows, read back from disk once it is let go, and taken up again where it was.
func TestLogKeptAndReadBack(t *testing.T) {
	tr := sessionTrajectories(t, t.TempDir())
	j := tr.Open("w1", 0)
	j.RunStarted(7)
	j.Asked("加分页", nil)
	j.ToolStarted("c1", ToolStart{Text: "ls", Action: protocol.ToolActionRunCommand, Tool: "bash"}, nil)
	j.ToolEnded("c1", "a\nb", true, nil)
	j.RunEnded(7, protocol.OutcomeCompleted)
	tr.Finish("w1")
	var kinds []string
	for _, s := range tr.Events("w1", 0) {
		out := ""
		if s.Output != nil {
			out = *s.Output
		}
		kinds = append(kinds, string(s.Type)+":"+out)
	}
	testkit.Eq(t, kinds, []string{"run/start:", "user/message:", "tool/call:a\nb", "run/end:"}, "read back")
	testkit.Eq(t, len(tr.Events("w1", 7)), 4, "the run's")
	testkit.Eq(t, len(tr.Events("w1", 8)), 0, "another run's")
	if tr.Events("../w1", 0) != nil {
		t.Fatal("nothing read from outside the folder")
	}
	testkit.Eq(t, len(tr.Open("w1", 0).Events()), 4, "taken up again")
}

func TestReasoningRunsOn(t *testing.T) {
	j := sessionTrajectories(t, t.TempDir()).Open("w1", 0)
	j.Thought("先看", nil)
	j.Thought("路由", nil)
	j.Said("好", nil)
	j.Thought("再想想", nil)
	j.ToolStarted("c1", ToolStart{Text: "ls", Action: protocol.ToolActionRunCommand, Tool: "bash"}, nil)
	j.Thought("看完了", nil)
	var got []string
	for _, s := range j.Events() {
		got = append(got, string(s.Type)+":"+s.Text)
	}
	testkit.Eq(t, got, []string{"assistant/thinking:先看路由", "assistant/message:好", "assistant/thinking:再想想", "tool/call:ls", "assistant/thinking:看完了"}, "steps")
}

func TestSubAgentStepsGoUnderTheirCall(t *testing.T) {
	j := sessionTrajectories(t, t.TempDir()).Open("w1", 0)
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
	for _, s := range j.Events() {
		out, under := "", "-"
		if s.Output != nil {
			out = *s.Output
		}
		if s.Under != nil {
			under = fmt.Sprint(*s.Under)
		}
		got = append(got, fmt.Sprintf("%d %s %s %s %s", s.Seq, s.Type, s.Text, out, under))
	}
	testkit.Eq(t, got, []string{
		"0 tool/call 派个帮手 看完了 -",
		"1 assistant/message 帮手先看看  0",
		"2 tool/call ls a.ts 0",
		"3 tool/call pwd /work -",
		"4 assistant/message 帮手看完了  0",
		"5 assistant/message 好  -",
		"6 assistant/message ，就这样  -1",
	}, "steps")
}

func TestJournalSendsAndWrites(t *testing.T) {
	home := t.TempDir()
	core := core.New(home)
	defer core.Close()
	_, events, stop := core.Events()
	defer stop()
	tr, _ := newTrajectories(fixture.Config(home, "", ""), core)
	j := tr.Open("w9", 0)
	j.Said("好", nil)
	j.Said("的", nil)
	select {
	case e := <-events:
		step, ok := e.Value.(protocol.SideEventSessionEvent)
		if !ok || step.ID != "w9" || step.SessionEvent.Text != "好的" {
			t.Fatalf("one step, grown, sent once: %+v", e.Value)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the step was not sent")
	}
	tr.Finish("w9")
	testkit.Eq(t, len(readJournal(filepath.Join(home, "events", "w9.json"))), 1, "written")
}
