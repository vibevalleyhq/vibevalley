package manager

import (
	vvagent "vibevalley/pkg/agent"
	"vibevalley/pkg/agentcore"
)

// Routing travels with the input through the agent's steering/follow-up queues.
// The caller is process-local and is deliberately absent from the transcript.
type managerInput struct {
	Conversation string `json:"conversation"`
	Agent        string `json:"agent,omitempty"`
	Quiet        bool   `json:"quiet,omitempty"`
	caller       *managerCaller
}

func managerInputOf(message agentcore.AgentMessage) (managerInput, bool) {
	custom, ok := message.(vvagent.CustomMessage)
	if !ok || custom.CustomType != "managerInput" {
		return managerInput{}, false
	}
	input, ok := custom.Details.(managerInput)
	return input, ok
}

// Tools run synchronously with the request; output routing follows the ordered event stream.
func (fm *manager) requestInput() managerInput {
	fm.starting.Lock()
	brain := fm.brain
	fm.starting.Unlock()
	if brain != nil {
		messages := brain.Core.State().Messages
		for i := len(messages) - 1; i >= 0; i-- {
			if input, ok := managerInputOf(messages[i]); ok {
				return input
			}
		}
	}
	fm.mu.Lock()
	defer fm.mu.Unlock()
	return fm.input
}
