package issue

import "vibevalley/internal/protocol"

// History joins actual live and ended sessions once; missing records remain explicit instead of inventing a phase.
func (is *issues) History() ([]protocol.IssueHistory, error) {
	issues, err := is.List()
	if err != nil {
		return nil, err
	}
	sessions, err := is.trajectories.List("")
	if err != nil {
		return nil, err
	}
	byID := make(map[string]protocol.Session, len(sessions))
	for _, session := range sessions {
		byID[session.ID] = session
	}
	out := make([]protocol.IssueHistory, 0, len(issues))
	for _, issue := range issues {
		entry := protocol.IssueHistory{Issue: issue, Sessions: []protocol.Session{}, MissingSessions: []string{}}
		for _, id := range issue.Sessions {
			if session, ok := byID[id]; ok {
				entry.Sessions = append(entry.Sessions, session)
			} else {
				entry.MissingSessions = append(entry.MissingSessions, id)
			}
		}
		out = append(out, entry)
	}
	return out, nil
}
