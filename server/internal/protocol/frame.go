package protocol

import "slices"

// What the client gets. The words for people (a worker's phaseText, a schedule's whenText and nextText) are said here and
// only here, on a copy: Reduce keeps the facts and what the services read, so the words never reach state.json.
func FrameOf(state CoreState, effects []GameEffect) StateFrame {
	if effects == nil {
		effects = []GameEffect{}
	}
	return StateFrame{State: withWords(state), Inbox: Inbox(state), Plans: PlaybooksOf(state), View: ViewOf(state), Effects: effects}
}

func withWords(state CoreState) CoreState {
	if len(state.Workers) > 0 {
		workers := slices.Clone(state.Workers)
		for i := range workers {
			workers[i].PhaseText = PhaseWords(workers[i])
		}
		state.Workers = workers
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
