package codex

import (
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// turnInputs are one turn's accepted steers (in acceptance order) and the
// inputs codex echoed as userMessage items.
type turnInputs struct {
	steers []string
	echoed map[string]bool
}

// codexInputs are the accepted steers and native echoes, keyed by the turn
// that owns them (input-delivery.ts). Never modified once built: a change
// makes a new value.
type codexInputs map[string]turnInputs

func (inputs codexInputs) with(turnID string, turn turnInputs) codexInputs {
	next := make(codexInputs, len(inputs)+1)
	for id, entry := range inputs {
		next[id] = entry
	}
	next[turnID] = turn
	return next
}

func (inputs codexInputs) without(turnID string) codexInputs {
	next := make(codexInputs, len(inputs))
	for id, entry := range inputs {
		if id != turnID {
			next[id] = entry
		}
	}
	return next
}

// acceptCodexSteer is called at the accepted steer RPC reply, before subsequent notifications.
func acceptCodexSteer(inputs codexInputs, turnID, inputID string) codexInputs {
	turn := inputs[turnID]
	if turn.echoed[inputID] {
		return inputs
	}
	steers := append([]string(nil), turn.steers...)
	present := false
	for _, id := range steers {
		present = present || id == inputID
	}
	if !present {
		steers = append(steers, inputID)
	}
	return inputs.with(turnID, turnInputs{steers: steers, echoed: turn.echoed})
}

// foldCodexInputs reads root-thread native evidence only. Codex clears
// pending steering on abort; its TUI restores precisely the unacknowledged
// steers at interrupted completion. Source and native probe:
// docs/runtimes/codex.md, "Interrupted input".
func foldCodexInputs(inputs codexInputs, method string, params jsonx.Record) (codexInputs, []oar.EventBody) {
	turnID, ok := params["turnId"].(string)
	if !ok {
		turnID, ok = jsonx.AsRecord(params["turn"])["id"].(string)
	}
	if !ok {
		return inputs, nil
	}
	item := jsonx.AsRecord(params["item"])
	clientID, hasClientID := item["clientId"].(string)
	if method == "item/started" && item["type"] == "userMessage" && hasClientID {
		turn := inputs[turnID]
		steers := []string{}
		for _, id := range turn.steers {
			if id != clientID {
				steers = append(steers, id)
			}
		}
		echoed := map[string]bool{clientID: true}
		for id := range turn.echoed {
			echoed[id] = true
		}
		return inputs.with(turnID, turnInputs{steers: steers, echoed: echoed}), nil
	}
	if method == "turn/completed" {
		var events []oar.EventBody
		if jsonx.AsRecord(params["turn"])["status"] == "interrupted" {
			for _, inputID := range inputs[turnID].steers {
				events = append(events, oar.InputDropped{InputID: inputID, Reason: "turn_interrupted"})
			}
		}
		return inputs.without(turnID), events
	}
	return inputs, nil
}

// codexUserInput is text followed by each local image, matching Codex's composer.
func codexUserInput(input string, images []oar.InputImage) []any {
	parts := []any{}
	if input != "" {
		parts = append(parts, map[string]any{"type": "text", "text": input})
	}
	for _, image := range images {
		parts = append(parts, map[string]any{"type": "localImage", "path": image.Path})
	}
	return parts
}
