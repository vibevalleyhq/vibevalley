package protocol

// Where each worker stands and what it has been doing, for the farm to draw: no business rule reads HelperPlay.

import "slices"

const (
	HistoryLimit = 30
	FileLimit    = 24
	CommandLimit = 12
)

// One saved before plays were kept has an empty one, with no bed.
func PlayOf(h Worker) WorkerPlay {
	if h.Play != nil {
		return *h.Play
	}
	return WorkerPlay{Station: -1, History: []ActionStep{}, Counts: map[string]int64{}, Files: []string{}, Commands: []string{}}
}

func FreeStation(workers []Worker, prefer *int64) int64 {
	taken := map[int64]bool{}
	for _, h := range workers {
		taken[PlayOf(h).Station] = true
	}
	if prefer != nil && *prefer >= 0 && *prefer < MaxRunning && !taken[*prefer] {
		return *prefer
	}
	for i := int64(0); i < MaxRunning; i++ {
		if !taken[i] {
			return i
		}
	}
	return -1
}

func WithStations(state CoreState) CoreState {
	if !slices.ContainsFunc(state.Workers, func(h Worker) bool { return PlayOf(h).Station < 0 }) {
		return state
	}
	var placed []Worker
	for _, h := range state.Workers {
		if PlayOf(h).Station >= 0 {
			placed = append(placed, h)
		}
	}
	for _, h := range state.Workers {
		if PlayOf(h).Station >= 0 {
			continue
		}
		play := PlayOf(h)
		play.Station = FreeStation(placed, nil)
		h.Play = &play
		placed = append(placed, h)
	}
	workers := make([]Worker, len(state.Workers))
	for i, h := range state.Workers {
		workers[i] = h
		for _, x := range placed {
			if x.ID == h.ID {
				workers[i] = x
				break
			}
		}
	}
	state.Workers = workers
	return state
}

func remember(list []string, item string, limit int) []string {
	out := slices.DeleteFunc(slices.Clone(list), func(x string) bool { return x == item })
	out = append(out, item)
	return out[max(0, len(out)-limit):]
}

func lastN[T any](list []T, n int) []T { return list[max(0, len(list)-n):] }

func IsToolAction(action WorkerAction) bool {
	switch action {
	case WorkerActionRunCommand, WorkerActionReadFile, WorkerActionEditFile, WorkerActionSearch, WorkerActionWeb, WorkerActionMCP, WorkerActionWait, WorkerActionOther:
		return true
	}
	return false
}

func playedRun(p WorkerPlay, at int64) WorkerPlay {
	p.ToolsThisRun = 0
	p.RunStartedAt = &at
	p.History = lastN(append(slices.Clone(p.History), ActionStep{At: at, Action: WorkerActionThinking, Label: ""}), HistoryLimit)
	return p
}

func playedDoing(p WorkerPlay, f FactDoing) WorkerPlay {
	if n := len(p.History); n > 0 && p.History[n-1].Action == f.Action && p.History[n-1].Label == f.Label {
		return p
	}
	next := p
	next.History = lastN(append(slices.Clone(p.History), ActionStep{At: f.At, Action: f.Action, Label: f.Label}), HistoryLimit)
	if !IsToolAction(f.Action) {
		return next
	}
	next.ToolsThisRun++
	counts := make(map[string]int64, len(p.Counts)+1)
	for k, v := range p.Counts {
		counts[k] = v
	}
	counts[string(f.Action)]++
	next.Counts = counts
	if (f.Action == WorkerActionEditFile || f.Action == WorkerActionReadFile) && f.Label != "" {
		next.Files = remember(p.Files, f.Label, FileLimit)
	} else if f.Action == WorkerActionRunCommand && f.Label != "" {
		next.Commands = remember(p.Commands, f.Label, CommandLimit)
	}
	return next
}

// Only to a bed that is free; a worker already there, or a bed taken, changes nothing.
func stationed(state CoreState, f FactStation) (CoreState, bool) {
	h := WorkerOf(state, f.ID)
	if h == nil || PlayOf(*h).Station == f.Station {
		return state, false
	}
	others := slices.DeleteFunc(slices.Clone(state.Workers), func(x Worker) bool { return x.ID == f.ID })
	if FreeStation(others, &f.Station) != f.Station {
		return state, false
	}
	return withWorker(state, f.ID, func(h Worker) Worker {
		play := PlayOf(h)
		play.Station = f.Station
		h.Play = &play
		return h
	})
}
