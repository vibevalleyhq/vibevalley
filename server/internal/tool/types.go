package tool

import "context"

// Who calls a tool. The manager's caller follows the input it is answering; a session's is fixed by its token.
type Caller struct {
	// The profile: protocol.ManagerAgent for the manager.
	Agent string
	// The session working as Agent, and the project it works in; both empty for the manager.
	Session string
	Project string
	// The conversation the manager is answering. A session's default is its own issue thread, which the channel service knows.
	Here string
	// The profile the owner picked for this input, if any: dispatch prefers it.
	Picked string
	// The owner's own words are in this input: only then may a merge happen.
	Owner bool
}

// Says who is calling, at the moment of the call. An error is told to the model as the tool's answer.
type Who func(ctx context.Context) (Caller, error)
