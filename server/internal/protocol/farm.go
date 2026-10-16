package protocol

// The farm's core state, in motion (packages/protocol/src/farm.ts): Reduce folds one fact into the state. The
// TypeScript reduce stays the reference until the pages read folded frames; parity_test.go folds the same facts
// through both and compares. Reduce never changes the state it is given: what it changes, it copies.

import (
	"reflect"
	"slices"
)

// MaxRunning is the subagents' running limit, and the number of beds on the farm.
const MaxRunning = 6

// What a helper's play keeps.
const (
	HistoryLimit = 30
	FileLimit    = 24
	CommandLimit = 12
)

// EmptyFarm is a farm with nothing on it.
func EmptyFarm() FarmState {
	return FarmState{Call: CallStateIdle, Foreman: ForemanStateIdle, Helpers: []Helper{}}
}

func HelperOf(state FarmState, id string) *Helper {
	for i := range state.Helpers {
		if state.Helpers[i].ID == id {
			return &state.Helpers[i]
		}
	}
	return nil
}

// withHelper changes one helper; the very same state when there is no such helper.
func withHelper(state FarmState, id string, change func(Helper) Helper) (FarmState, bool) {
	i := slices.IndexFunc(state.Helpers, func(h Helper) bool { return h.ID == id })
	if i < 0 {
		return state, false
	}
	helpers := slices.Clone(state.Helpers)
	helpers[i] = change(helpers[i])
	state.Helpers = helpers
	return state, true
}

// whileWorking changes a working helper's phase; any other phase stays.
func whileWorking(state FarmState, id string, change func(PhaseWorking) PhaseWorking) (FarmState, bool) {
	h := HelperOf(state, id)
	if h == nil {
		return state, false
	}
	if _, ok := h.Phase.Value.(PhaseWorking); !ok {
		return state, false
	}
	return withHelper(state, id, func(h Helper) Helper {
		h.Phase = Phase{change(h.Phase.Value.(PhaseWorking))}
		return h
	})
}

// IsOpen is whether a playbook is still going: not harvested, not given up.
func IsOpen(pb Playbook) bool {
	return pb.State != PlaybookStateDone && pb.State != PlaybookStateAbandoned
}

// PlayOf is a helper's play; one saved before plays were kept has an empty one, with no bed.
func PlayOf(h Helper) HelperPlay {
	if h.Play != nil {
		return *h.Play
	}
	return HelperPlay{Station: -1, History: []ActionStep{}, Counts: map[string]int64{}, Files: []string{}, Commands: []string{}}
}

// FreeStation is the bed a new helper takes: prefer when it is free, else the first free one, else -1.
func FreeStation(helpers []Helper, prefer *int64) int64 {
	taken := map[int64]bool{}
	for _, h := range helpers {
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

// WithStations gives every helper without a bed a free one.
func WithStations(state FarmState) FarmState {
	if !slices.ContainsFunc(state.Helpers, func(h Helper) bool { return PlayOf(h).Station < 0 }) {
		return state
	}
	var placed []Helper
	for _, h := range state.Helpers {
		if PlayOf(h).Station >= 0 {
			placed = append(placed, h)
		}
	}
	for _, h := range state.Helpers {
		if PlayOf(h).Station >= 0 {
			continue
		}
		play := PlayOf(h)
		play.Station = FreeStation(placed, nil)
		h.Play = &play
		placed = append(placed, h)
	}
	helpers := make([]Helper, len(state.Helpers))
	for i, h := range state.Helpers {
		helpers[i] = h
		for _, x := range placed {
			if x.ID == h.ID {
				helpers[i] = x
				break
			}
		}
	}
	state.Helpers = helpers
	return state
}

// remember appends item, moving it to the end if present, and keeps the last limit.
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

func playedTurn(p HelperPlay, at int64) HelperPlay {
	p.ToolsThisTurn = 0
	p.TurnStartedAt = &at
	p.History = lastN(append(slices.Clone(p.History), ActionStep{At: at, Action: WorkerActionThinking, Label: ""}), HistoryLimit)
	return p
}

func playedDoing(p HelperPlay, f FactDoing) HelperPlay {
	if n := len(p.History); n > 0 && p.History[n-1].Action == f.Action && p.History[n-1].Label == f.Label {
		return p
	}
	next := p
	next.History = lastN(append(slices.Clone(p.History), ActionStep{At: f.At, Action: f.Action, Label: f.Label}), HistoryLimit)
	if !IsToolAction(f.Action) {
		return next
	}
	next.ToolsThisTurn++
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

func ended(outcome Outcome) Phase {
	switch outcome {
	case OutcomeCompleted:
		return Phase{PhaseRipe{}}
	case OutcomeFailed:
		return Phase{PhaseFailed{}}
	default:
		return Phase{PhaseResting{}}
	}
}

func same(a, b any) bool { return reflect.DeepEqual(a, b) }

// Reduce is the state after fact, and whether it changed: facts about helpers not on the farm change nothing. The
// issues' statuses follow whatever changed (their runs at work or done).
func Reduce(state FarmState, fact Fact) (FarmState, bool) {
	next, changed := reduce(state, fact)
	if changed && len(next.Issues) > 0 {
		next = withIssueStatuses(next)
	}
	return next, changed
}

// reduce is Reduce before the issues' statuses follow what changed.
func reduce(state FarmState, fact Fact) (FarmState, bool) {
	switch f := fact.Value.(type) {
	case FactCall:
		state.Call = f.State
		state.CallReason = nil
		if f.Reason != nil && *f.Reason != "" {
			state.CallReason = f.Reason
		}
		return state, true
	case FactForeman:
		state.Foreman = f.State
		return state, true
	case FactMessage:
		if state.Chat != nil {
			for _, m := range state.Chat.Messages {
				if m.Seq == f.Message.Seq && same(m, f.Message) {
					return state, false
				}
			}
		}
		chat := WithMessage(state.Chat, f.Message)
		state.Chat = &chat
		return state, true
	case FactConversation:
		if state.Chat != nil {
			for _, c := range state.Chat.Conversations {
				if c.ID == f.Conversation.ID && same(c, f.Conversation) {
					return state, false
				}
			}
		}
		chat := WithConversation(state.Chat, f.Conversation)
		state.Chat = &chat
		return state, true
	case FactHired:
		others := slices.DeleteFunc(slices.Clone(state.Helpers), func(h Helper) bool { return h.ID == f.Helper.ID })
		var play HelperPlay
		if was := HelperOf(state, f.Helper.ID); was != nil && was.Play != nil {
			play = *was.Play
		} else {
			play = PlayOf(f.Helper)
			play.Station = FreeStation(others, f.Station)
		}
		h := f.Helper
		h.Play = &play
		state.Helpers = append(others, h)
		return state, true
	case FactTurn:
		return withHelper(state, f.ID, func(h Helper) Helper {
			if f.Task != nil && *f.Task != "" {
				h.Task = *f.Task
			}
			h.Phase = Phase{PhaseWorking{Since: f.At, Doing: Doing{Action: WorkerActionThinking, Label: ""}}}
			play := playedTurn(PlayOf(h), f.At)
			h.Play = &play
			return h
		})
	case FactDoing:
		after, changed := whileWorking(state, f.ID, func(p PhaseWorking) PhaseWorking {
			return PhaseWorking{Since: p.Since, Doing: Doing{Action: f.Action, Label: f.Label}}
		})
		if !changed {
			return state, false
		}
		return withHelper(after, f.ID, func(h Helper) Helper {
			play := playedDoing(PlayOf(h), f)
			h.Play = &play
			return h
		})
	case FactQuiet:
		return whileWorking(state, f.ID, func(p PhaseWorking) PhaseWorking {
			since := f.Since
			p.QuietSince = &since
			return p
		})
	case FactRetry:
		return whileWorking(state, f.ID, func(p PhaseWorking) PhaseWorking {
			r := Retry{Attempt: f.Attempt}
			if f.Of != nil && *f.Of != 0 {
				r.Of = f.Of
			}
			p.Retry = &r
			return p
		})
	case FactSpent:
		return withHelper(state, f.ID, func(h Helper) Helper {
			spent := f.Spent
			h.Spent = &spent
			return h
		})
	case FactReport:
		if HelperOf(state, f.ID) == nil {
			return state, false
		}
		next, _ := withHelper(state, f.ID, func(x Helper) Helper {
			x.Turns = f.Turns
			x.Phase = ended(f.Outcome)
			x.Last = &LastTurn{Outcome: f.Outcome, Summary: f.Summary, At: f.At, Spent: f.Spent}
			return x
		})
		return next, true
	case FactConflict:
		return withHelper(state, f.ID, func(h Helper) Helper {
			h.Conflict = f.Conflict
			return h
		})
	case FactLeft:
		state.Helpers = slices.DeleteFunc(slices.Clone(state.Helpers), func(h Helper) bool { return h.ID == f.ID })
		return state, true
	case FactCommits:
		commits := f.Commits
		state.Commits = &commits
		return state, true
	case FactProgress:
		progress := f.Progress
		state.Progress = &progress
		return state, true
	case FactSchedule:
		all := slices.Clone(state.Schedules)
		i := slices.IndexFunc(all, func(x FarmSchedule) bool { return x.ID == f.Schedule.ID })
		if i >= 0 && same(all[i], f.Schedule) {
			return state, false
		}
		if i >= 0 {
			all[i] = f.Schedule
		} else {
			all = append(all, f.Schedule)
		}
		state.Schedules = all
		return state, true
	case FactUnschedule:
		if !slices.ContainsFunc(state.Schedules, func(x FarmSchedule) bool { return x.ID == f.ID }) {
			return state, false
		}
		state.Schedules = slices.DeleteFunc(slices.Clone(state.Schedules), func(x FarmSchedule) bool { return x.ID == f.ID })
		return state, true
	case FactIssue:
		for _, t := range state.Issues {
			if t.ID == f.Issue.ID && same(t, f.Issue) {
				return state, false
			}
		}
		state.Issues = withIssue(state.Issues, f.Issue)
		return state, true
	case FactIssueGone:
		if !slices.ContainsFunc(state.Issues, func(x Issue) bool { return x.ID == f.ID }) {
			return state, false
		}
		state.Issues = slices.DeleteFunc(slices.Clone(state.Issues), func(x Issue) bool { return x.ID == f.ID })
		return state, true
	}
	return state, false
}
