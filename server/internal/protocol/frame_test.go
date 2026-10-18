package protocol

import (
	"testing"

	"vibevalley/internal/testkit"
)

func TestTheFrameSaysTheWordsOnACopy(t *testing.T) {
	state := withGraphs(EmptyCoreState(), TaskGraph{ID: "p1", CreatedAt: 1, State: GraphStateRunning, Tasks: []Task{{ID: "n1", Title: "一步", State: TaskStateWaiting}}})
	state.Sessions = []Session{{ID: "w1", Phase: Phase{PhaseRipe{}}}}
	state.Schedules = []Schedule{scheduleMake()}
	frame := FrameOf(state, nil)
	testkit.Eq(t, frame.State.Sessions[0].PhaseText, PhaseWords(state.Sessions[0]), "the session's words")
	testkit.Eq(t, frame.State.Schedules[0].WhenText, "每天 09:00", "the schedule's")
	testkit.Eq(t, [2]string{state.Sessions[0].PhaseText, state.Schedules[0].WhenText}, [2]string{"", ""}, "the state itself keeps none")
	testkit.Eq(t, frame.Effects, []GameEffect{}, "no effects is []")
	testkit.Eq(t, len(frame.Inbox), 1, "a ripe session asks for you")
	testkit.Eq(t, frame.Graphs[0].Tasks[0].StateText, "等着", "the node's words")
	testkit.Eq(t, frame.Graphs[0].StateTag, "在做", "the task's tag")
	testkit.Eq(t, frame.Graphs[0].ActionText["pause"], "暂停", "the action's word")
	testkit.Eq(t, frame.Graphs[0].Actions, []GraphAction{GraphActionPause, GraphActionAbandon}, "the actions the state allows")
	testkit.Eq(t, frame.Graphs[0].Tasks[0].Actions, []TaskAction{TaskActionSkip}, "the node actions")
	testkit.Eq(t, frame.Graphs[0].Tasks[0].ActionText["skip"], "跳过", "the node action's word")
	testkit.Eq(t, [2]bool{frame.Graphs[0].Tasks[0].CanEdit, frame.Graphs[0].Tasks[0].CanRemove}, [2]bool{true, true}, "the node edit gates")
}
