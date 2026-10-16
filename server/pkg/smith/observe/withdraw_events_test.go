package observe_test

import (
	"testing"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// tests/withdraw-events.test.ts (the withdrawHeld case is kernel's, not observe's).

const weInputID = "11111111-2222-4333-8444-555555555555"

func weEnvelope(seq int64) oar.Envelope {
	return oar.Envelope{SessionID: "s", AgentPath: []string{}, Seq: seq}
}

func weQueue(seq int64, id string) oar.RawEvent {
	return oar.RawEvent{Envelope: weEnvelope(seq), Kind: oar.KindRequest, ID: id, Direction: oar.ToRuntime, Request: oar.RequestBody{Kind: oar.RequestQueue, Input: "later", InputID: weInputID}}
}

func weWithdraw(seq int64, id, target string) oar.RawEvent {
	if target == "" {
		target = weInputID
	}
	return oar.RawEvent{Envelope: weEnvelope(seq), Kind: oar.KindRequest, ID: id, Direction: oar.ToRuntime, Request: oar.RequestBody{Kind: oar.RequestWithdraw, InputID: target}}
}

func weAccepted(seq int64, requestID string) oar.RawEvent {
	return oar.RawEvent{Envelope: weEnvelope(seq), Kind: oar.KindResponse, RequestID: requestID, Response: oar.Accepted()}
}

func weNotQueued(seq int64, requestID string) oar.RawEvent {
	return oar.RawEvent{Envelope: weEnvelope(seq), Kind: oar.KindResponse, RequestID: requestID, Response: oar.Rejected(oar.CodeNotQueued, "no held input with this inputId is waiting")}
}

func weOnlyInput(t *testing.T, records ...oar.RawEvent) observe.ConversationInput {
	t.Helper()
	inputs := observe.ConversationOf(records).Inputs.Values()
	if len(inputs) != 1 {
		t.Fatalf("inputs = %d", len(inputs))
	}
	return inputs[0]
}

func TestWithdrawEventsReadAsWithdrawnOrRejected(t *testing.T) {
	records := []oar.RawEvent{weQueue(0, "q"), weAccepted(1, "q"), weWithdraw(2, "w1", ""), weAccepted(3, "w1"), weWithdraw(4, "w2", ""), weNotQueued(5, "w2")}
	expected := `[{"kind":"input_withdrawn","requestId":"w1","inputId":"` + weInputID + `","seq":3},{"kind":"control_rejected","requestId":"w2","action":"withdraw","code":"not_queued","seq":5}]`
	fxMatch(t, eventsOf(records), expected)
	// A retained log replays into the same events.
	actions := observe.ControlActionsOf(records)
	replayed := []oar.Event{}
	for _, record := range records {
		replayed = append(replayed, observe.EventsOf(record, actions)...)
	}
	fxMatch(t, replayed, expected)
	// Without the request, the response alone names no input: nothing is guessed.
	fxEqual(t, nonNilEvents(observe.EventsOf(weAccepted(3, "w1"), nil)), `[]`)
}

func nonNilEvents(events []oar.Event) []oar.Event {
	if events == nil {
		return []oar.Event{}
	}
	return events
}

func TestWithdrawEventsAcceptedWithdrawMakesInputWithdrawn(t *testing.T) {
	input := weOnlyInput(t, weQueue(0, "q"), weAccepted(1, "q"), weWithdraw(2, "w", ""), weAccepted(3, "w"))
	fxMatch(t, input, `{"state":"withdrawn","input":"later","inputId":"`+weInputID+`"}`)
	rows := [][]string{}
	for _, attempt := range input.Attempts {
		rows = append(rows, []string{string(attempt.Request.Request.Kind), attempt.State})
	}
	fxEqual(t, rows, `[["queue","accepted"],["withdraw","accepted"]]`)
}

func TestWithdrawEventsUnansweredOrRefusedChangesNothing(t *testing.T) {
	if got := weOnlyInput(t, weQueue(0, "q"), weAccepted(1, "q"), weWithdraw(2, "w", "")).State; got != "accepted" {
		t.Fatalf("unanswered: %s", got)
	}
	if got := weOnlyInput(t, weQueue(0, "q"), weAccepted(1, "q"), weWithdraw(2, "w", ""), weNotQueued(3, "w")).State; got != "accepted" {
		t.Fatalf("refused: %s", got)
	}
}

func TestWithdrawEventsRequeueFollowsOrdinaryRules(t *testing.T) {
	withdrawn := []oar.RawEvent{weQueue(0, "q1"), weAccepted(1, "q1"), weWithdraw(2, "w", ""), weAccepted(3, "w")}
	with := func(more ...oar.RawEvent) []oar.RawEvent {
		return append(append([]oar.RawEvent{}, withdrawn...), more...)
	}
	if got := weOnlyInput(t, with(weQueue(4, "q2"))...).State; got != "pending" {
		t.Fatalf("requeued: %s", got)
	}
	if got := weOnlyInput(t, with(weQueue(4, "q2"), weAccepted(5, "q2"))...).State; got != "accepted" {
		t.Fatalf("accepted: %s", got)
	}
	if got := weOnlyInput(t, with(weQueue(4, "q2"), weAccepted(5, "q2"), weWithdraw(6, "w2", ""), weAccepted(7, "w2"))...).State; got != "withdrawn" {
		t.Fatalf("withdrawn again: %s", got)
	}
}

func TestWithdrawEventsUnknownInputMakesNoBubble(t *testing.T) {
	unknown := "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"
	state := observe.ConversationOf([]oar.RawEvent{weWithdraw(0, "w", unknown)})
	if state.Inputs.Len() != 0 {
		t.Fatalf("inputs = %d", state.Inputs.Len())
	}
	fxMatch(t, observe.ReduceConversation(state, weNotQueued(1, "w"), "").Updates, `[{"kind":"event","event":{"kind":"control_rejected","action":"withdraw","code":"not_queued"}}]`)
	fxMatch(t, observe.ReduceConversation(state, weAccepted(1, "w"), "").Updates, `[{"kind":"event","event":{"kind":"input_withdrawn","inputId":"`+unknown+`"}}]`)
}
