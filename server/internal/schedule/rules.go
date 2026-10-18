package schedule

import (
	"strings"

	"vibevalley/internal/protocol"
)

// A run later than this after it was due was missed (the server was off), and says so.
const missedAfterMs = 5 * 60_000

// Each once, however many runs it missed.
func dueSchedules(all []protocol.Schedule, now int64) []protocol.Schedule {
	out := []protocol.Schedule{}
	for _, s := range all {
		if next, ok := protocol.NextRun(s); ok && next <= now {
			out = append(out, s)
		}
	}
	return out
}

func isMissed(s protocol.Schedule, now int64) bool {
	next, ok := protocol.NextRun(s)
	if !ok {
		next = now
	}
	return now-next > missedAfterMs
}

// A one-off runs once: then it is off.
func afterRun(s protocol.Schedule, now int64) protocol.Schedule {
	s.LastRun = &now
	if _, ok := s.When.Value.(protocol.ScheduleWhenOnce); ok {
		s.Enabled = false
	}
	return s
}

// Whether a schedule waits for the owner's yes before it can come due. The owner's own never waits, nor the manager's when the
// owner asked in this run. Without the owner, the manager may only set itself a one-off follow-up: one that comes back again,
// or sends a helper (who spends money) straight away, waits.
func needsOK(req protocol.ScheduleRequest, by protocol.ScheduleBy, ownerInRun bool) bool {
	switch by {
	case protocol.ScheduleByOwner:
		return false
	case protocol.ScheduleByManager:
		if ownerInRun {
			return false
		}
		_, once := req.When.Value.(protocol.ScheduleWhenOnce)
		direct := req.Agent != nil && strings.TrimSpace(*req.Agent) != ""
		return !once || direct
	}
	panic("schedule: set by nobody: " + string(by))
}
