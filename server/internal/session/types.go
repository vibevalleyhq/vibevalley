package session

import (
	"vibevalley/internal/project"
	"vibevalley/internal/protocol"
)

type Roster struct {
	Session  protocol.Session
	Place    project.Workplace
	LastText string
}

type Hired struct {
	Session *protocol.Session
	Evicted string
	Refused string
}

type HireOptions struct {
	// Base is the branch its own branch starts from; empty: the project's main branch.
	Base     string
	Worktree *bool
	Playbook *protocol.SessionPlaybook
	Channel  *string
	// Empty: Dispatch makes one from the job.
	Issue string
	// What its first run is for; nil: the issue sent out.
	Trigger *protocol.RunTrigger
	// Called with the session just before it goes on the farm, so what must know of it first (its issue's link) is
	// written before anyone can see it, or its first run end.
	Hiring func(protocol.Session) error
}

type Delivered struct {
	Kind   string // run, steered, queued, refused
	Launch string
	Woke   bool
	Reason string
}

type LaunchActivity struct {
	Kind    string // spoke, ended, closed, compacting
	ID      string
	Launch  string
	Outcome protocol.Outcome
	Spoke   bool
	On      bool
}

type ToolStart struct {
	Text   string
	Action protocol.ToolAction
	Tool   string
	Input  string
}

// Empty is the agent itself, else the lineage of a sub-agent it started.
type From []string

type Journal interface {
	Events() []protocol.SessionEvent
	Asked(text string, from From)
	Said(text string, from From)
	Thought(text string, from From)
	ToolStarted(callID string, start ToolStart, from From)
	ToolInput(callID, input, text string, from From)
	ToolEnded(callID, output string, ok bool, from From)
	Note(kind protocol.SessionEventType, text string, from From)
	// An llm/usage: one model answer's tokens, with text to show for them.
	Usage(tokens protocol.EventTokens, text string, from From)
	// RunStarted opens run id: every event after it is the run's until RunEnded closes it with how it ended.
	RunStarted(id string)
	RunEnded(id string, outcome protocol.Outcome)
	Close()
}
