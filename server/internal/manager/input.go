package manager

import (
	"encoding/json"

	vvagent "vibevalley/pkg/agent"
	"vibevalley/pkg/agentcore"
)

// Routing travels with the input through the agent's steering/follow-up queues.
// The caller is process-local and is deliberately absent from the transcript.
type managerInput struct {
	Conversation string `json:"conversation"`
	Agent        string `json:"agent,omitempty"`
	Quiet        bool   `json:"quiet,omitempty"`
	// The issue handed to the manager that this input is; its run ends when the manager's settles.
	Issue  string `json:"issue,omitempty"`
	caller *managerCaller
}

func managerInputOf(message agentcore.AgentMessage) (managerInput, bool) {
	custom, ok := message.(vvagent.CustomMessage)
	if !ok || custom.CustomType != "managerInput" {
		return managerInput{}, false
	}
	switch details := custom.Details.(type) {
	case managerInput:
		return details, true
	// Read back from manager.jsonl.
	case map[string]any:
		var input managerInput
		data, err := json.Marshal(details)
		if err != nil || json.Unmarshal(data, &input) != nil {
			return managerInput{}, false
		}
		return input, true
	}
	return managerInput{}, false
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
