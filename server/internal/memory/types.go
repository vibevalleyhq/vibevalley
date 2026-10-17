package memory

import (
	"vibevalley/internal/protocol"
)

type FinishedRun struct {
	Agent   string
	Session string
	Project string
	Job     string
	Outcome protocol.Outcome
	Said    string
	Summary string
}

type RecallCue struct {
	Agent   string
	Session string
	Project string
	Text    string
	Skip    map[string]bool
}
