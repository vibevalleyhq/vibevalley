package protocol

import "slices"

// What the client gets. The words for people (a session's phaseText, a schedule's whenText and nextText) are said here and
// only here, on a copy: Reduce keeps the facts and what the services read, so the words never reach state.json.
func FrameOf(state CoreState, effects []GameEffect) StateFrame {
	if effects == nil {
		effects = []GameEffect{}
	}
	plans := PlaybooksOf(state)
	for i := range plans {
		plans[i].StateTag = PlaybookStateTag[plans[i].State]
		plans[i].ActionText = make(map[string]string, len(PlaybookActionText))
		for action, word := range PlaybookActionText {
			plans[i].ActionText[string(action)] = word
		}
		plans[i].Actions = PlaybookActions(plans[i])
		if len(plans[i].Nodes) == 0 {
			continue
		}
		nodes := slices.Clone(plans[i].Nodes)
		for j := range nodes {
			nodes[j].StateText = NodeStateText[nodes[j].State]
			nodes[j].Actions = NodeActions(plans[i], nodes[j])
			nodes[j].ActionText = make(map[string]string, len(nodes[j].Actions))
			for _, action := range nodes[j].Actions {
				nodes[j].ActionText[string(action)] = NodeActionText[action]
			}
			nodes[j].CanEdit = CanEditNode(plans[i], &nodes[j])
			nodes[j].CanRemove = CanRemoveNode(plans[i], &nodes[j])
		}
		plans[i].Nodes = nodes
	}
	return StateFrame{State: withWords(state), Inbox: Inbox(state), Plans: plans, View: ViewOf(state), Effects: effects}
}

func withWords(state CoreState) CoreState {
	if len(state.Sessions) > 0 {
		sessions := slices.Clone(state.Sessions)
		for i := range sessions {
			sessions[i].PhaseText = PhaseWords(sessions[i])
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
