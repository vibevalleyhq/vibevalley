package worker

import (
	"vibevalley/internal/project"
	"vibevalley/internal/protocol"
)

type Roster struct {
	Worker   protocol.Worker
	Place    project.Workplace
	LastText string
}

type Hired struct {
	Worker  *protocol.Worker
	Evicted string
	Refused string
}

type HireOptions struct {
	// Base is the branch its own branch starts from; empty: the project's main branch.
	Base     string
	Worktree *bool
	Playbook *protocol.WorkerPlaybook
	Channel  *int64
	// Empty: Dispatch makes one from the job.
	Issue string
	// What its first run is for; nil: the issue sent out.
	Trigger *protocol.RunTrigger
	// Called with the worker just before it goes on the farm, so what must know of it first (its issue's link) is
	// written before anyone can see it, or its first run end.
	Hiring func(protocol.Worker)
}

type Delivered struct {
	Kind    string // run, steered, queued, refused
	Session string
	Woke    bool
	Reason  string
}

type SessionActivity struct {
	Kind    string // spoke, ended, closed, compacting
	ID      string
	Session string
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
	Activities() []protocol.Activity
	Asked(text string, from From)
	Said(text string, from From)
	Thought(text string, from From)
	ToolStarted(callID string, start ToolStart, from From)
	ToolInput(callID, input, text string, from From)
	ToolEnded(callID, output string, ok bool, from From)
	Note(kind protocol.ActivityKind, text string, from From)
	Close()
}
