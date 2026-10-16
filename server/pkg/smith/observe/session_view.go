package observe

import "vibevalley/pkg/smith/oar"

// The chat-UI projection (observe/session-view.ts; docs/design/chat-ui.md):
// grouped messages, agent status, model/usage/context and runtime requests
// awaiting answers. Pure over the record stream: replayable from a log, no
// clock, no IO.
//
// Grouping rules, all derived never synthesized:
//   - A TURN is a display segment: it opens on its prompt request or on the
//     first turn-content event while none is open (adopted: queued input
//     consumed, mid-turn subscriber, replay slice). A conflicting native start
//     after queue evidence, a dropped input or a rejected prompt removes its
//     empty provisional turn. Queue evidence alone changes no layout.
//     turn_ended of the ROOT session stamps the open segment; an input
//     entering mid-turn seals the current segment so seq order stays the
//     render order, and later content opens a new segment.
//   - An INPUT enters where the runtime took it. A prompt enters at its
//     request provisionally; native queue evidence arms attribution, and a
//     conflicting turn moves it to pending until its matching native turn
//     start. A steer or queue enters at its first native echo (user_message
//     with its inputId) when the stream echoes input ids at all, which it shows
//     by having echoed one before (codex, claude); until then it waits in
//     PendingInputs. On a stream that never echoed one (pi, cursor, ACP
//     runtimes) it enters at its request, the best fact known. A refused input
//     enters where it was refused; a retry of it that must wait for its echo
//     takes it back out. A dropped input enters at its discard/exit; a
//     withdrawn input leaves PendingInputs and Messages; the segment its
//     request sealed stays sealed.
//   - A SECTION groups one lane (sessionId, agentPath), in first-appearance
//     order. Named text and readable reasoning rejoin the same kind/messageId
//     part anywhere in that lane's current segment, never across an input
//     seal. Tools, notices and unnamed content keep stream order; unnamed
//     messages can still fragment. Redacted/empty reasoning stay
//     lifecycle-only parts. A child agent's or session's turn_ended is a
//     notice, never a root end.
//   - A TOOL part is one per lane and callId: a progress or end settles it in
//     the turn its start landed in, even after that turn ended; only a call
//     whose start was never seen becomes a "?" part. A root turn end or exit
//     changes its unresolved root tools to "ended", without a result content
//     or tool end time. Later native results still replace that unknown result.
//   - A root exit stamps the record-derived status outcome on its open turn:
//     aborted after an accepted abort or dispose request, failed otherwise.
//     Flat events lack accepted controls: exit ends tools without a turn outcome.

// InitialSessionView is the empty view.
func InitialSessionView() SessionView {
	return SessionView{
		Messages:        []ViewMessage{},
		PendingInputs:   []ConversationInput{},
		OpenTurn:        -1,
		Status:          InitialStatus,
		PendingRequests: []PendingRequest{},
		Conversation:    InitialConversation(),
		SessionGraph:    oar.SessionGraph{Nodes: []oar.SessionNode{}, Edges: []oar.SessionEdge{}},
		UsageBySession:  NewOrderedMap[*SessionTokens](),
		UsageByAgent:    NewOrderedMap[oar.AgentTotal](),
	}
}

// ReduceSessionView folds one record into the view. streamID scopes
// input/request identity the way it does for ReduceConversation: one value
// per native stream, changed across resume so restarted seq domains never
// collide.
func ReduceSessionView(previous SessionView, record oar.RawEvent, streamID string) SessionView {
	if cursor, ok := previous.Conversation.Cursors.Get(streamID); record.Seq <= cursorOr(cursor, ok) {
		// Already folded in this stream (an overlapping history and live push): a no-op.
		next := previous
		next.Conversation.Updates = []ConversationUpdate{}
		return next
	}
	d := draftOf(previous)
	if d.rootSessionID == "" {
		d.rootSessionID = record.SessionID
	}
	d.sessionGraph = withSessionNode(d.sessionGraph, record.SessionID)
	if record.Kind == oar.KindRequest && record.Direction == oar.ToRuntime && record.Request.Kind == oar.RequestPrompt {
		d.rootSessionID = record.SessionID
	}
	status := ReduceStatus(previous.Status, record, d.rootSessionID)
	if record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseExited && previous.Status.IsRunning() && status.Kind == "idle" && status.LastTurnOutcome != nil {
		stampTurnOutcome(d, turnID(streamID, record.SessionID, record.Seq), *status.LastTurnOutcome)
	}
	conversation := ReduceConversation(previous.Conversation, record, streamID)
	for _, update := range conversation.Updates {
		if update.Kind == "input" {
			foldInputUpdate(d, update.Input, conversation)
		} else {
			deferWaitingInputs(d, update.Event, conversation)
			foldEvent(d, update.Event, streamID, turnOpenedBy(update.Event, conversation))
		}
	}
	recordFacts(d, record, streamID)
	return assemble(d, conversation, status)
}

// ReduceSessionViewEvent is the same fold for pre-flattened Events
// (Session.Events subscribers and logs that predate record envelopes). Input
// facts do not arrive this way; feed them through ReduceSessionViewInput or
// use the record path. A pre-0.14.0 tool end's output is already upgraded
// to content when the event is decoded (oar.DecodeEventBody), the Go form of
// upgradeLegacyEvent.
func ReduceSessionViewEvent(previous SessionView, event oar.Event, streamID string) SessionView {
	d := draftOf(previous)
	if d.rootSessionID == "" {
		d.rootSessionID = event.SessionID
	}
	d.sessionGraph = withSessionNode(d.sessionGraph, event.SessionID)
	foldEvent(d, event, streamID, "")
	return assemble(d, previous.Conversation, previous.Status)
}

// ReduceSessionViewInput upserts a user input from a non-record source (an
// app's own submission log); it enters Messages now.
func ReduceSessionViewInput(previous SessionView, input ConversationInput) SessionView {
	d := draftOf(previous)
	upsertInput(d, input, false)
	return assemble(d, previous.Conversation, previous.Status)
}

// ViewOf replays a whole record log into a view, as one stream.
func ViewOf(records []oar.RawEvent, streamID string) SessionView {
	state := InitialSessionView()
	for _, record := range records {
		state = ReduceSessionView(state, record, streamID)
	}
	return state
}

// ObserveSessionView is the composed subscriber: it folds the retained
// prefix and pushes the view on every record after cursor (nil: every
// record). The stream id is the session's id.
func ObserveSessionView(session oar.Session, observer func(SessionView), cursor *oar.Cursor) oar.Unsubscribe {
	state := InitialSessionView()
	after := int64(-1)
	if cursor != nil {
		after = cursor.AfterSeq
	}
	streamID := session.ID()
	return session.RawEvents(func(record oar.RawEvent) {
		state = ReduceSessionView(state, record, streamID)
		if record.Seq > after {
			observer(state)
		}
	}, &oar.Cursor{SessionID: streamID, AfterSeq: -1})
}
