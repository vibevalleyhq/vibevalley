package observe

import (
	"slices"

	"vibevalley/pkg/smith/oar"
)

// Where a user input enters the session view (observe/session-view-inputs.ts):
// the INPUT rule in the session view's doc, applied per input update.

// upsertInput upserts a user input. One waiting for its echo goes to
// pendingInputs; otherwise it enters messages, and a NEW entry seals the open
// segment (seq order is render order). A placed input that must now wait (a
// refused attempt retried as a steer or queue) leaves messages again. A
// withdrawn input leaves both lists.
func upsertInput(d *draft, input ConversationInput, awaitEcho bool) {
	id := "in:" + input.ID
	index := slices.IndexFunc(d.messages, func(message ViewMessage) bool { return message.ID == id })
	if input.State == "withdrawn" {
		withdrawInput(d, input, index)
		return
	}
	if index != -1 && !awaitEcho {
		copied := input
		d.messages[index] = ViewMessage{Kind: "input", ID: id, Input: &copied}
		return
	}
	if index != -1 {
		removeInput(d, index)
	}
	pending := slices.IndexFunc(d.pendingInputs, func(waiting ConversationInput) bool { return waiting.ID == input.ID })
	if awaitEcho {
		if pending == -1 {
			d.pendingInputs = append(d.pendingInputs, input)
		} else {
			d.pendingInputs[pending] = input
		}
		return
	}
	if pending != -1 {
		d.pendingInputs = slices.Delete(d.pendingInputs, pending, pending+1)
	}
	copied := input
	d.messages = append(d.messages, ViewMessage{Kind: "input", ID: id, Input: &copied})
	sealTurn(d)
}

// withdrawInput: an input taken back before it was sent leaves pendingInputs
// and, on a stream that placed it at its request, messages. Unlike
// removeInput, the segment its entry sealed stays sealed: the records folded
// since were placed around it, and joining the segments again would be a
// merge the stream never said.
func withdrawInput(d *draft, input ConversationInput, index int) {
	if index != -1 {
		d.messages = slices.Delete(d.messages, index, index+1)
		if d.openTurn > index {
			d.openTurn--
		}
	}
	if pending := slices.IndexFunc(d.pendingInputs, func(waiting ConversationInput) bool { return waiting.ID == input.ID }); pending != -1 {
		d.pendingInputs = slices.Delete(d.pendingInputs, pending, pending+1)
	}
}

// removeInput takes a placed input back out of messages. When it was the last
// message, the outcome-less turn right before it is the segment its entry
// sealed, so that segment opens again instead of splitting at an input no
// longer there.
func removeInput(d *draft, index int) {
	d.messages = slices.Delete(d.messages, index, index+1)
	if d.openTurn > index {
		d.openTurn--
		return
	}
	if d.openTurn == -1 && index == len(d.messages) && index >= 1 {
		if before := d.messages[index-1]; before.Kind == "turn" && before.Outcome == nil {
			d.openTurn = index - 1
			d.turnCloned = false
		}
	}
}

// foldInputUpdate: queue evidence arms attribution; only an actual conflicting turn defers a placed input.
func foldInputUpdate(d *draft, input ConversationInput, conversation ConversationState) {
	if input.State == "dropped" && len(input.Attempts) > 0 {
		if request := input.Attempts[len(input.Attempts)-1].Request; request.Request.Kind == oar.RequestPrompt {
			removeEmptyTurn(d, request.ID)
		}
	}
	wait := awaitsEcho(input, conversation.Inputs)
	if input.Turn != nil && input.Turn.State == "queued" {
		wait = wait && slices.ContainsFunc(d.pendingInputs, func(pending ConversationInput) bool { return pending.ID == input.ID })
	}
	upsertInput(d, input, wait)
}

// deferWaitingInputs splits a provisional prompt only when native activity actually belongs to another turn.
func deferWaitingInputs(d *draft, event oar.Event, conversation ConversationState) {
	active, ok := event.Body.(oar.TurnActive)
	if !ok || event.SessionID != d.rootSessionID || len(event.AgentPath) > 0 {
		return
	}
	conversation.Inputs.All(func(_ string, input ConversationInput) bool {
		if input.Turn == nil || input.Turn.State != "queued" || input.InputID == active.InputID || len(input.Attempts) == 0 {
			return true
		}
		request := input.Attempts[len(input.Attempts)-1].Request
		if request.SessionID != event.SessionID || len(request.AgentPath) > 0 {
			return true
		}
		if request.Request.Kind == oar.RequestPrompt {
			removeEmptyTurn(d, request.ID)
		}
		sealTurn(d)
		upsertInput(d, input, true)
		return true
	})
}

// turnOpenedBy is the prompt request whose native turn start this event is; "" otherwise.
func turnOpenedBy(event oar.Event, conversation ConversationState) string {
	active, ok := event.Body.(oar.TurnActive)
	if !ok || active.InputID == "" {
		return ""
	}
	input, found := conversation.Inputs.Get(jsonKey(event.SessionID, pathOrEmpty(event.AgentPath), active.InputID))
	if !found || input.Turn == nil || input.Turn.State != "active" || len(input.Attempts) == 0 {
		return ""
	}
	if request := input.Attempts[len(input.Attempts)-1].Request; request.Request.Kind == oar.RequestPrompt {
		return request.ID
	}
	return ""
}
