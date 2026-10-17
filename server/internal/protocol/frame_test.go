package protocol

import (
	"testing"

	"vibevalley/internal/testkit"
)

func TestTheFrameSaysTheWordsOnACopy(t *testing.T) {
	state := withPlaybooks(EmptyCoreState(), Playbook{ID: "p1", CreatedAt: 1, State: PlaybookStateRunning, Nodes: []PlaybookNode{{ID: "n1", Title: "一步", State: NodeStateWaiting}}})
	state.Sessions = []Session{{ID: "w1", Phase: Phase{PhaseRipe{}}}}
	state.Schedules = []Schedule{scheduleMake()}
	frame := FrameOf(state, nil)
	testkit.Eq(t, frame.State.Sessions[0].PhaseText, PhaseWords(state.Sessions[0]), "the session's words")
	testkit.Eq(t, frame.State.Schedules[0].WhenText, "每天 09:00", "the schedule's")
	testkit.Eq(t, [2]string{state.Sessions[0].PhaseText, state.Schedules[0].WhenText}, [2]string{"", ""}, "the state itself keeps none")
	testkit.Eq(t, frame.Effects, []GameEffect{}, "no effects is []")
	testkit.Eq(t, len(frame.Inbox), 1, "a ripe session asks for you")
	testkit.Eq(t, frame.Plans[0].Nodes[0].StateText, "等着", "the node's words")
	testkit.Eq(t, frame.Plans[0].StateTag, "在做", "the plan's tag")
}
