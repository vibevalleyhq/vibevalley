package observe

import (
	"encoding/json"
	"slices"

	"vibevalley/pkg/smith/oar"
)

// The conversation fold (observe/conversation.ts): user inputs as the
// stream proves them, apart from the events.

// InputAttempt is a delivery attempt (prompt, steer, queue) or a withdraw of the input.
type InputAttempt struct {
	Request  oar.RawEvent
	StreamID string
	Response *oar.RawEvent
	// "pending" | "accepted" | "rejected"
	State string
	// The rejection's reason (State "rejected").
	Reason string
}

func (a InputAttempt) MarshalJSON() ([]byte, error) {
	out := map[string]any{"request": a.Request, "streamId": a.StreamID, "state": a.State}
	if a.Response != nil {
		out["response"] = *a.Response
	}
	if a.State == "rejected" && a.Response != nil {
		out["reason"] = a.Reason
	}
	return marshalNoEscape(out)
}

// InputTurn is native queue/start evidence for an attempt.
type InputTurn struct {
	// "queued" | "active"
	State    string `json:"state"`
	Seq      int64  `json:"seq"`
	StreamID string `json:"streamId"`
}

// ConversationInput is one user input as the stream proves it.
type ConversationInput struct {
	// Stable projection key, scoped to native session and agent lineage.
	ID      string
	InputID string
	Input   string
	// The images the input carried, from its latest request; nil when none.
	Images []oar.InputImage
	// Who the input came from, from its latest request; nil when the host said nothing.
	Origin *oar.InputOrigin
	// "pending" | "accepted" | "rejected" | "withdrawn" | "dropped" | "untracked".
	// withdrawn: an accepted withdraw took the held input back and no delivery attempt followed it.
	State string
	// Only for dropped input: "turn_interrupted" | "runtime_exited" | "runtime_refused".
	// runtime_exited means no echo was observed before exit, not proof it was never read.
	Reason string
	// Every request that targeted the input, in fold order, each with its observed response.
	Attempts []InputAttempt
	// Native queue/start evidence for this attempt; cleared on drop or a new attempt.
	Turn *InputTurn
	// Native user_message observations; none of these alone proves model consumption.
	Observations []oar.Event
}

func (c ConversationInput) MarshalJSON() ([]byte, error) {
	out := map[string]any{
		"id":           c.ID,
		"input":        c.Input,
		"state":        c.State,
		"attempts":     nonNilSlice(c.Attempts),
		"observations": nonNilSlice(c.Observations),
	}
	if c.InputID != "" {
		out["inputId"] = c.InputID
	}
	if len(c.Images) > 0 {
		out["images"] = c.Images
	}
	if c.Origin != nil {
		out["origin"] = c.Origin
	}
	if c.Reason != "" {
		out["reason"] = c.Reason
	}
	if c.Turn != nil {
		out["turn"] = c.Turn
	}
	return marshalNoEscape(out)
}

// ConversationUpdate is one change a record produced: Kind "input" (Input) or "event" (Event).
type ConversationUpdate struct {
	Kind  string
	Input ConversationInput
	Event oar.Event
}

func (u ConversationUpdate) MarshalJSON() ([]byte, error) {
	if u.Kind == "input" {
		return marshalNoEscape(map[string]any{"kind": "input", "input": u.Input})
	}
	return marshalNoEscape(map[string]any{"kind": "event", "event": u.Event})
}

// ConversationState is the fold's state. Its maps are frozen once returned.
type ConversationState struct {
	Inputs   *OrderedMap[ConversationInput]
	Requests *OrderedMap[string]
	// Attempts settled by the latest drop; later attempts can take ownership again.
	Drops   *OrderedMap[InputDrop]
	Actions *OrderedMap[KnownControl]
	Cursors *OrderedMap[int64]
	// Changes produced by this record, in record order; use for incremental UI updates.
	Updates []ConversationUpdate
}

func (s ConversationState) MarshalJSON() ([]byte, error) {
	return marshalNoEscape(map[string]any{
		"inputs":   orEmpty(s.Inputs),
		"requests": orEmpty(s.Requests),
		"drops":    orEmpty(s.Drops),
		"actions":  orEmpty(s.Actions),
		"cursors":  orEmpty(s.Cursors),
		"updates":  nonNilSlice(s.Updates),
	})
}

// MarshalJSON writes a known control as TS keeps it: the action, or the withdraw body.
func (k KnownControl) MarshalJSON() ([]byte, error) {
	if k.Action == oar.ActionWithdraw {
		return json.Marshal(map[string]any{"kind": "withdraw", "inputId": k.InputID})
	}
	return json.Marshal(k.Action)
}

// InitialConversation is the empty fold.
func InitialConversation() ConversationState {
	return ConversationState{
		Inputs:   NewOrderedMap[ConversationInput](),
		Requests: NewOrderedMap[string](),
		Drops:    NewOrderedMap[InputDrop](),
		Actions:  NewOrderedMap[KnownControl](),
		Cursors:  NewOrderedMap[int64](),
		Updates:  []ConversationUpdate{},
	}
}

// identity is the input key: JSON of [sessionId, agentPath, id].
func identity(record oar.Envelope, id string) string {
	return jsonKey(record.SessionID, pathOrEmpty(record.AgentPath), id)
}

func appendClone[T any](values []T, more ...T) []T {
	return append(values[:len(values):len(values)], more...)
}

// ReduceConversation folds one record. One ordered stream per streamID: use
// a new streamID after a runtime resume (seq restarts). Input UUIDs and
// native message ids can still connect observations across those streams.
// Missing ids never fall back to text matching; unlinked user messages
// remain event updates.
func ReduceConversation(previous ConversationState, record oar.RawEvent, streamID string) ConversationState {
	if cursor, ok := previous.Cursors.Get(streamID); record.Seq <= cursorOr(cursor, ok) {
		next := previous
		next.Updates = []ConversationUpdate{}
		return next
	}
	inputs := cowOf(previous.Inputs)
	drops := cowOf(previous.Drops)
	requests := cowOf(previous.Requests)
	actions := cowOf(previous.Actions)
	cursors := orEmpty(previous.Cursors).With(streamID, record.Seq)
	updates := []ConversationUpdate{}
	operationKey := func(id string) string { return jsonKey(streamID, identity(record.Envelope, id)) }
	publish := func(input ConversationInput) {
		inputs.set(input.ID, input)
		updates = append(updates, ConversationUpdate{Kind: "input", Input: input})
	}
	dropOf := func(id string) *InputDrop {
		if drop, ok := drops.get(id); ok {
			return &drop
		}
		return nil
	}
	handled := false
	if record.Kind == oar.KindRequest && record.Direction == oar.ToRuntime && record.Request.Kind != oar.RequestNative {
		known, _ := KnownControlOf(record.Request)
		actions.set(operationKey(record.ID), known)
		var target *ConversationInput
		if record.Request.Kind == oar.RequestWithdraw {
			if found, ok := inputs.get(identity(record.Envelope, record.Request.InputID)); ok {
				target = &found
			}
		}
		if target != nil && len(target.Attempts) > 0 {
			// A withdraw is an attempt on the input it targets, never a bubble of its own.
			attempts := appendClone(target.Attempts, InputAttempt{Request: record, StreamID: streamID, State: "pending"})
			requests.set(operationKey(record.ID), target.ID)
			publish(withDeliveryState(*target, attempts, dropOf(target.ID)))
			handled = true
		} else if record.Request.IsInput() {
			body := record.Request
			id := operationKey(record.ID)
			if body.InputID != "" {
				id = identity(record.Envelope, body.InputID)
			}
			existing, _ := inputs.get(id)
			attempts := appendClone(existing.Attempts, InputAttempt{Request: record, StreamID: streamID, State: "pending"})
			requests.set(operationKey(record.ID), id)
			input := ConversationInput{ID: id, Input: body.Input, InputID: body.InputID, Origin: body.Origin, Attempts: attempts, Observations: nonNilSlice(existing.Observations)}
			if len(body.Images) > 0 {
				input.Images = body.Images
			}
			input.State, input.Reason = deliveryState(attempts, dropOf(id))
			publish(input)
			handled = true
		}
	} else if record.Kind == oar.KindResponse {
		id, found := requests.get(operationKey(record.RequestID))
		var input ConversationInput
		ok := false
		if found {
			input, ok = inputs.get(id)
		}
		if ok && (record.Response.Kind == oar.ResponseAccepted || record.Response.Kind == oar.ResponseRejected) {
			attempts := make([]InputAttempt, len(input.Attempts))
			for i, attempt := range input.Attempts {
				if attempt.Request.ID != record.RequestID || attempt.StreamID != streamID {
					attempts[i] = attempt
					continue
				}
				response := record
				settled := InputAttempt{Request: attempt.Request, StreamID: streamID, Response: &response, State: string(record.Response.Kind)}
				if record.Response.Kind == oar.ResponseRejected {
					settled.Reason = record.Response.Reason
				}
				attempts[i] = settled
			}
			publish(withDeliveryState(input, attempts, dropOf(input.ID)))
			handled = true
		}
	}
	if record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseExited {
		for _, key := range inputs.current().Keys() {
			input, _ := inputs.get(key)
			if len(input.Attempts) == 0 {
				continue
			}
			last := input.Attempts[len(input.Attempts)-1]
			if last.StreamID != streamID || last.Request.SessionID != record.SessionID ||
				!isPrefix(record.AgentPath, last.Request.AgentPath) || !awaitsEcho(input, inputs.current()) {
				continue
			}
			drop := InputDrop{Attempts: len(input.Attempts), Reason: "runtime_exited"}
			drops.set(input.ID, drop)
			publish(withDeliveryState(input, input.Attempts, &drop))
		}
	}
	if !handled {
		control := map[string]KnownControl{}
		if record.Kind == oar.KindResponse {
			if action, ok := actions.get(operationKey(record.RequestID)); ok {
				control[record.RequestID] = action
			}
		}
		for _, event := range EventsOf(record, control) {
			switch body := event.Body.(type) {
			case oar.InputQueued, oar.TurnActive:
				inputID := ""
				queued := false
				if q, isQueued := body.(oar.InputQueued); isQueued {
					inputID, queued = q.InputID, true
				} else {
					inputID = body.(oar.TurnActive).InputID
				}
				if !queued && inputID == "" {
					updates = append(updates, ConversationUpdate{Kind: "event", Event: event})
					continue
				}
				input, ok := inputs.get(identity(record.Envelope, inputID))
				if ok && (queued || (input.Turn != nil && input.Turn.State == "queued" && input.Turn.StreamID == streamID)) {
					state := "active"
					if queued {
						state = "queued"
					}
					input.Turn = &InputTurn{State: state, Seq: event.Seq, StreamID: streamID}
					publish(input)
				}
				updates = append(updates, ConversationUpdate{Kind: "event", Event: event})
			case oar.InputDropped:
				input, ok := inputs.get(identity(record.Envelope, body.InputID))
				if !ok {
					updates = append(updates, ConversationUpdate{Kind: "event", Event: event})
					continue
				}
				drop := InputDrop{Attempts: len(input.Attempts), Reason: body.Reason}
				drops.set(input.ID, drop)
				publish(withDeliveryState(input, input.Attempts, &drop))
			case oar.UserMessage:
				if body.InputID == "" {
					updates = append(updates, ConversationUpdate{Kind: "event", Event: event})
					continue
				}
				id := identity(record.Envelope, body.InputID)
				input, ok := inputs.get(id)
				if !ok {
					input = ConversationInput{ID: id, InputID: body.InputID, Input: body.Input, State: "untracked", Attempts: []InputAttempt{}, Observations: []oar.Event{}}
				}
				if body.NativeMessageID != "" && slices.ContainsFunc(input.Observations, func(observation oar.Event) bool {
					seen, isMessage := observation.Body.(oar.UserMessage)
					return isMessage && seen.NativeMessageID == body.NativeMessageID && seen.Evidence == body.Evidence
				}) {
					continue
				}
				// Exit proves only that no echo arrived before death. A resumed
				// transcript can supply the missing evidence without a new attempt.
				current := input
				if drop, dropped := drops.get(id); dropped && drop.Reason == "runtime_exited" && drop.Attempts == len(input.Attempts) {
					drops.delete(id)
					current = withDeliveryState(input, input.Attempts, nil)
				}
				current.Observations = appendClone(input.Observations, event)
				publish(current)
			default:
				updates = append(updates, ConversationUpdate{Kind: "event", Event: event})
			}
		}
	}
	if record.Kind == oar.KindResponse {
		actions.delete(operationKey(record.RequestID))
	}
	return ConversationState{Drops: drops.current(), Inputs: inputs.current(), Requests: requests.current(), Actions: actions.current(), Cursors: cursors, Updates: updates}
}

func cursorOr(cursor int64, ok bool) int64 {
	if ok {
		return cursor
	}
	return -1
}

// isPrefix reports whether every part of prefix matches path at its index.
func isPrefix(prefix, path []string) bool {
	if len(prefix) > len(path) {
		return false
	}
	for i, part := range prefix {
		if path[i] != part {
			return false
		}
	}
	return true
}

// ConversationOf folds a whole log with the default stream.
func ConversationOf(records []oar.RawEvent) ConversationState {
	state := InitialConversation()
	for _, record := range records {
		state = ReduceConversation(state, record, "")
	}
	return state
}

// ObserveConversation folds the session's retained prefix (a cursor can
// start after an input request) and calls observer with the state on every
// record after cursor (nil: every record).
func ObserveConversation(session oar.Session, observer func(ConversationState), cursor *oar.Cursor) oar.Unsubscribe {
	state := InitialConversation()
	after := int64(-1)
	if cursor != nil {
		after = cursor.AfterSeq
	}
	return session.RawEvents(func(record oar.RawEvent) {
		state = ReduceConversation(state, record, "")
		if record.Seq > after {
			observer(state)
		}
	}, &oar.Cursor{SessionID: session.ID(), AfterSeq: -1})
}
