package schedule

import "vibevalley/internal/protocol"

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
