package claude

import (
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
)

// inputSet is an immutable set of inputIds: every change is a copy.
type inputSet map[string]bool

func (s inputSet) with(id string) inputSet {
	out := make(inputSet, len(s)+1)
	for key := range s {
		out[key] = true
	}
	out[id] = true
	return out
}

func (s inputSet) without(id string) inputSet {
	out := make(inputSet, len(s))
	for key := range s {
		if key != id {
			out[key] = true
		}
	}
	return out
}

// claudePrompted is control plane → state: a prompt clears stale abort
// intent and starts a new native input attempt (input-lifecycle.ts).
// inputID "" is none; prompted false is a queue write or a drain.
func claudePrompted(state projectionState, inputID string, prompted bool) projectionState {
	state.AbortRequested = false
	state.TurnActive = prompted
	state.UnclaimedInit = false
	state.PromptInputID = inputID
	state.PendingInputID = ""
	if inputID != "" {
		state.PromptInputs = state.PromptInputs.with(inputID)
		state.UnstartedInputs = state.UnstartedInputs.with(inputID)
		state.UnacknowledgedInputs = state.UnacknowledgedInputs.with(inputID)
	}
	return state
}

// claudeInitialized keeps an unclaimed root init until queued can prove it
// belongs to a spontaneous turn.
func claudeInitialized(state projectionState, root bool) (projectionState, []oar.EventBody) {
	if !root {
		return state, nil
	}
	spontaneous := !state.TurnActive
	state.UnclaimedInit = state.UnclaimedInit || (!spontaneous && !state.NativeTurnActive && state.PromptInputID != "" && state.UnstartedInputs[state.PromptInputID])
	state.TurnActive = true
	state.NativeTurnActive = true
	if spontaneous {
		return state, []oar.EventBody{oar.TurnActive{}}
	}
	return state, nil
}

func forgetInput(state projectionState, inputID string) projectionState {
	state.PromptInputs = state.PromptInputs.without(inputID)
	state.UnstartedInputs = state.UnstartedInputs.without(inputID)
	state.UnacknowledgedInputs = state.UnacknowledgedInputs.without(inputID)
	if state.PromptInputID == inputID {
		state.PromptInputID = ""
		state.TurnActive = state.NativeTurnActive
		state.UnclaimedInit = false
	}
	if state.PendingInputID == inputID {
		state.PendingInputID = ""
	}
	return state
}

// claudeDuplicateInput: a replay/completed without queued or started since
// this write is Claude's duplicate-id refusal.
func claudeDuplicateInput(state projectionState, inputID string, root bool) (projectionState, []oar.EventBody) {
	if root && state.PromptInputs[inputID] && state.UnacknowledgedInputs[inputID] {
		return forgetInput(state, inputID), []oar.EventBody{oar.InputDropped{InputID: inputID, Reason: "runtime_refused", Failure: oar.FailureInvalidRequest,
			Message: "claude ignored the input: its inputId was already used in this session"}}
	}
	return state, nil
}

// claudeInputLifecycle folds a command_lifecycle frame. Only prompt-like
// writes own a turn. A steer can be started inside the current turn.
func claudeInputLifecycle(state projectionState, message jsonx.Record, root bool) (projectionState, []oar.EventBody) {
	inputID, ok := message["command_uuid"].(string)
	if !ok || !state.PromptInputs[inputID] || !root {
		return state, nil
	}
	unacknowledged := state.UnacknowledgedInputs.without(inputID)
	switch message["state"] {
	case "queued":
		// An init can beat this receipt after the host writes. Only now is it
		// known to belong to another turn; preserve the facts in this frame's order.
		spontaneous := inputID == state.PromptInputID && state.UnclaimedInit
		events := []oar.EventBody{oar.InputQueued{InputID: inputID}}
		if spontaneous {
			events = append(events, oar.TurnActive{})
		}
		state.UnacknowledgedInputs = unacknowledged
		if inputID == state.PromptInputID {
			state.TurnActive = state.NativeTurnActive
			state.UnclaimedInit = false
			state.PendingInputID = inputID
		}
		return state, events
	case "started":
		state.TurnActive = true
		state.NativeTurnActive = true
		state.UnclaimedInit = false
		state.UnstartedInputs = state.UnstartedInputs.without(inputID)
		state.UnacknowledgedInputs = unacknowledged
		if state.PendingInputID == inputID {
			state.PendingInputID = ""
		}
		return state, []oar.EventBody{oar.TurnActive{InputID: inputID}}
	case "cancelled":
		var events []oar.EventBody
		if state.UnstartedInputs[inputID] {
			events = []oar.EventBody{oar.InputDropped{InputID: inputID, Reason: "turn_interrupted"}}
		}
		return forgetInput(state, inputID), events
	case "completed":
		// completed never ends a turn; without queued/started it confirms an ignored duplicate.
		next, events := claudeDuplicateInput(state, inputID, root)
		return forgetInput(next, inputID), events
	}
	return state, nil
}

type userMessageImage struct {
	Type   string            `json:"type"`
	Source userMessageSource `json:"source"`
}

type userMessageSource struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
}

type userMessageText struct {
	Type string `json:"type"`
	Text string `json:"text"`
}

// claudeUserMessage is one stream-json user message; images go before the
// text, as the Messages API recommends. inputID "" is none.
func claudeUserMessage(text, inputID string, images []kernel.LoadedImage) string {
	content := []any{}
	for _, image := range images {
		content = append(content, userMessageImage{Type: "image", Source: userMessageSource{Type: "base64", MediaType: image.MediaType, Data: image.Data}})
	}
	if text != "" {
		content = append(content, userMessageText{Type: "text", Text: text})
	}
	type message struct {
		Role    string `json:"role"`
		Content []any  `json:"content"`
	}
	type frame struct {
		Type    string  `json:"type"`
		UUID    string  `json:"uuid,omitempty"`
		Message message `json:"message"`
	}
	return jsonText(frame{Type: "user", UUID: inputID, Message: message{Role: "user", Content: content}}) + "\n"
}
