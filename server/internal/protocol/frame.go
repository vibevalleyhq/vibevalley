package protocol

import "slices"

// What the client gets. The words for people (a session's phaseText, a schedule's whenText and nextText) are said here and
// only here, on a copy: Reduce keeps the facts and what the services read, so the words never reach state.json.
func FrameOf(state CoreState, effects []GameEffect) StateFrame {
	if effects == nil {
		effects = []GameEffect{}
	}
	graphs := GraphsOf(state)
	for i := range graphs {
		graphs[i].StateTag = GraphStateTag[graphs[i].State]
		graphs[i].ActionText = make(map[string]string, len(GraphActionText))
		for action, word := range GraphActionText {
			graphs[i].ActionText[string(action)] = word
		}
		graphs[i].Actions = GraphActions(graphs[i])
		if len(graphs[i].Tasks) == 0 {
			continue
		}
		tasks := slices.Clone(graphs[i].Tasks)
		for j := range tasks {
			tasks[j].StateText = TaskStateText[tasks[j].State]
			tasks[j].Actions = TaskActions(graphs[i], tasks[j])
			tasks[j].ActionText = make(map[string]string, len(tasks[j].Actions))
			for _, action := range tasks[j].Actions {
				tasks[j].ActionText[string(action)] = TaskActionText[action]
			}
			tasks[j].CanEdit = CanEditTask(graphs[i], &tasks[j])
			tasks[j].CanRemove = CanRemoveTask(graphs[i], &tasks[j])
		}
		graphs[i].Tasks = tasks
	}
	return StateFrame{State: withWords(state), Inbox: Inbox(state), Graphs: graphs, View: ViewOf(state), Effects: effects}
}

func withWords(state CoreState) CoreState {
	if len(state.Sessions) > 0 {
		sessions := slices.Clone(state.Sessions)
		for i := range sessions {
			sessions[i].PhaseText = PhaseWords(sessions[i])
			// The phase and the play are the state's: changed on copies.
			if p, ok := sessions[i].Phase.Value.(PhaseWorking); ok {
				p.Doing.ActionText = ActionText[p.Doing.Action]
				sessions[i].Phase = Phase{p}
			}
			if play := sessions[i].Play; play != nil && len(play.History) > 0 {
				copied := *play
				copied.History = slices.Clone(play.History)
				for j := range copied.History {
					copied.History[j].ActionText = ActionText[copied.History[j].Action]
				}
				sessions[i].Play = &copied
			}
		}
		state.Sessions = sessions
	}
	if len(state.Schedules) > 0 {
		schedules := slices.Clone(state.Schedules)
		for i, s := range schedules {
			schedules[i].WhenText, schedules[i].NextText = WhenText(s.When, s.TZ), NextText(s)
		}
		state.Schedules = schedules
	}
	return state
}
