package protocol

// The farm's core state, in motion: Reduce folds one fact into the state; reduce_golden_test.go holds it to recorded
// runs of facts. Reduce never changes the state it is given: what it changes, it copies.

import (
	"reflect"
	"slices"
)

func EmptyCoreState() CoreState {
	return CoreState{Call: CallStateIdle, Manager: ManagerStateIdle, Workers: []Worker{}}
}

func WorkerOf(state CoreState, id string) *Worker {
	for i := range state.Workers {
		if state.Workers[i].ID == id {
			return &state.Workers[i]
		}
	}
	return nil
}

// The very same state when there is no such worker.
func withWorker(state CoreState, id string, change func(Worker) Worker) (CoreState, bool) {
	i := slices.IndexFunc(state.Workers, func(h Worker) bool { return h.ID == id })
	if i < 0 {
		return state, false
	}
	workers := slices.Clone(state.Workers)
	workers[i] = change(workers[i])
	state.Workers = workers
	return state, true
}

func whileWorking(state CoreState, id string, change func(PhaseWorking) PhaseWorking) (CoreState, bool) {
	h := WorkerOf(state, id)
	if h == nil {
		return state, false
	}
	if _, ok := h.Phase.Value.(PhaseWorking); !ok {
		return state, false
	}
	return withWorker(state, id, func(h Worker) Worker {
		h.Phase = Phase{change(h.Phase.Value.(PhaseWorking))}
		return h
	})
}

func IsOpen(pb Playbook) bool {
	return pb.State != PlaybookStateDone && pb.State != PlaybookStateAbandoned
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

func EmptyProgress() Progress {
	return Progress{Coins: 0, Streak: 0, BestStreak: 0, Counts: map[string]int64{}, Unlocked: []Unlock{}, Multiplier: 1}
}

func same(a, b any) bool { return reflect.DeepEqual(a, b) }

// A fact that changes nothing says so (false), and Core.Apply does not send it; facts about workers not on the farm change
// nothing. The issues' statuses follow whatever changed.
func Reduce(state CoreState, fact Fact) (CoreState, bool) {
	next, changed := reduce(state, fact)
	if changed && len(next.Issues) > 0 {
		next = withIssueStatuses(next)
	}
	return next, changed
}

func reduce(state CoreState, fact Fact) (CoreState, bool) {
	switch f := fact.Value.(type) {
	case FactCall:
		var reason *string
		if f.Reason != nil && *f.Reason != "" {
			reason = f.Reason
		}
		if state.Call == f.State && same(state.CallReason, reason) {
			return state, false
		}
		state.Call, state.CallReason = f.State, reason
		return state, true
	case FactManager:
		if state.Manager == f.State {
			return state, false
		}
		state.Manager = f.State
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
		others := slices.DeleteFunc(slices.Clone(state.Workers), func(h Worker) bool { return h.ID == f.Worker.ID })
		var play WorkerPlay
		if was := WorkerOf(state, f.Worker.ID); was != nil && was.Play != nil {
			play = *was.Play
		} else {
			play = PlayOf(f.Worker)
			play.Station = FreeStation(others, nil)
		}
		h := f.Worker
		h.Play = &play
		state.Workers = append(others, h)
		return state, true
	case FactStation:
		return stationed(state, f)
	case FactRun:
		return withWorker(state, f.ID, func(h Worker) Worker {
			if f.Task != nil && *f.Task != "" {
				h.Task = *f.Task
			}
			h.Phase = Phase{PhaseWorking{Since: f.At, Doing: Doing{Action: WorkerActionThinking, Label: ""}}}
			play := playedRun(PlayOf(h), f.At)
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
		return withWorker(after, f.ID, func(h Worker) Worker {
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
		return withWorker(state, f.ID, func(h Worker) Worker {
			spent := f.Spent
			h.Spent = &spent
			return h
		})
	case FactReport:
		if WorkerOf(state, f.ID) == nil {
			return state, false
		}
		next, _ := withWorker(state, f.ID, func(x Worker) Worker {
			x.Runs = f.Runs
			x.Phase = ended(f.Outcome)
			x.LastRun = &LastRun{Outcome: f.Outcome, Summary: f.Summary, At: f.At, Spent: f.Spent}
			return x
		})
		return next, true
	case FactConflict:
		return withWorker(state, f.ID, func(h Worker) Worker {
			h.Conflict = f.Conflict
			return h
		})
	case FactLeft:
		state.Workers = slices.DeleteFunc(slices.Clone(state.Workers), func(h Worker) bool { return h.ID == f.ID })
		return state, true
	case FactCommits:
		if state.Commits != nil && same(*state.Commits, f.Commits) {
			return state, false
		}
		commits := f.Commits
		state.Commits = &commits
		return state, true
	case FactProgress:
		if state.Progress != nil && same(*state.Progress, f.Progress) {
			return state, false
		}
		progress := f.Progress
		state.Progress = &progress
		return state, true
	case FactSchedule:
		sc := f.Schedule
		all := slices.Clone(state.Schedules)
		i := slices.IndexFunc(all, func(x Schedule) bool { return x.ID == sc.ID })
		if i >= 0 && same(all[i], sc) {
			return state, false
		}
		if i >= 0 {
			all[i] = sc
		} else {
			all = append(all, sc)
		}
		state.Schedules = all
		return state, true
	case FactUnschedule:
		if !slices.ContainsFunc(state.Schedules, func(x Schedule) bool { return x.ID == f.ID }) {
			return state, false
		}
		state.Schedules = slices.DeleteFunc(slices.Clone(state.Schedules), func(x Schedule) bool { return x.ID == f.ID })
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
