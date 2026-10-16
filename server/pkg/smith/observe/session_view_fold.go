package observe

import (
	"slices"

	"vibevalley/pkg/smith/oar"
)

// Per-record fold internals for the session view (observe/session-view-fold.ts).
// Every reduction works on a draft: the message array copied once per record,
// the open turn and its sections cloned lazily on first write, everything else
// shared until touched. A slice reached from a previous view is never written
// in place: it is cloned first.

type draft struct {
	messages      []ViewMessage
	pendingInputs []ConversationInput
	openTurn      int
	// Whether messages[openTurn] already has a sections slice of its own this record (TS draft.turn !== null).
	turnCloned      bool
	pendingRequests []PendingRequest
	model           *string
	effort          *string
	serviceTier     *string
	context         *oar.ContextUsage
	exited          *ExitInfo
	usageBySession  *cow[*SessionTokens]
	sessionGraph    oar.SessionGraph
	rootSessionID   string
}

func draftOf(state SessionView) *draft {
	return &draft{
		messages:        slices.Clone(nonNilSlice(state.Messages)),
		pendingInputs:   slices.Clone(nonNilSlice(state.PendingInputs)),
		openTurn:        state.OpenTurn,
		pendingRequests: slices.Clone(nonNilSlice(state.PendingRequests)),
		model:           state.Model,
		effort:          state.Effort,
		serviceTier:     state.ServiceTier,
		context:         state.Context,
		exited:          state.Exited,
		usageBySession:  cowOf(state.UsageBySession),
		sessionGraph:    state.SessionGraph,
		rootSessionID:   state.RootSessionID,
	}
}

func assemble(d *draft, conversation ConversationState, status oar.AgentStatus) SessionView {
	sessions := d.usageBySession.current()
	byID := make(map[string]*SessionTokens, sessions.Len())
	sessions.All(func(id string, tokens *SessionTokens) bool {
		byID[id] = tokens
		return true
	})
	usage := UsageFromSessions(byID, d.rootSessionID, d.sessionGraph)
	own, _ := sessions.Get(d.rootSessionID)
	return SessionView{
		Messages:        d.messages,
		PendingInputs:   d.pendingInputs,
		OpenTurn:        d.openTurn,
		Status:          status,
		Model:           d.model,
		Effort:          d.effort,
		ServiceTier:     d.serviceTier,
		Context:         d.context,
		Usage:           usage,
		PendingRequests: d.pendingRequests,
		Exited:          d.exited,
		Conversation:    conversation,
		RootSessionID:   d.rootSessionID,
		UsageBySession:  sessions,
		SessionGraph:    d.sessionGraph,
		UsageByAgent:    own.agentsMap(),
		UsageTotal:      own.Total(),
	}
}

// ─── Graph (observe/graph.ts withSessionNode / withSessionLink) ────────────

// withSessionNode: record envelopes establish nodes.
func withSessionNode(graph oar.SessionGraph, id string) oar.SessionGraph {
	if slices.ContainsFunc(graph.Nodes, func(node oar.SessionNode) bool { return node.ID == id }) {
		return graph
	}
	return oar.SessionGraph{Nodes: appendClone(nonNilSlice(graph.Nodes), oar.SessionNode{ID: id}), Edges: nonNilSlice(graph.Edges)}
}

// withSessionLink: the same native edge may be reported many times; the graph contains it once.
func withSessionLink(graph oar.SessionGraph, edge oar.SessionEdge) oar.SessionGraph {
	nodes := withSessionNode(withSessionNode(graph, edge.Parent), edge.Child)
	if slices.ContainsFunc(nodes.Edges, func(known oar.SessionEdge) bool { return known.Parent == edge.Parent && known.Child == edge.Child }) {
		return nodes
	}
	return oar.SessionGraph{Nodes: nodes.Nodes, Edges: appendClone(nonNilSlice(nodes.Edges), oar.SessionEdge{Parent: edge.Parent, Child: edge.Child, Via: edge.Via})}
}

// ─── Turn and section access ──────────────────────────────────────────────

func sectionInLane(section ViewSection, sessionID string, agentPath []string) bool {
	return section.SessionID == sessionID && slices.Equal(pathOrEmpty(section.AgentPath), pathOrEmpty(agentPath))
}

// turnForWrite is the open turn, cloned for writing at most once per record.
// The pointer is valid until the next change to d.messages.
func turnForWrite(d *draft) *ViewMessage {
	if d.openTurn == -1 {
		return nil
	}
	if !d.turnCloned {
		if d.openTurn >= len(d.messages) || d.messages[d.openTurn].Kind != "turn" {
			return nil
		}
		message := d.messages[d.openTurn]
		message.Sections = slices.Clone(nonNilSlice(message.Sections))
		d.messages[d.openTurn] = message
		d.turnCloned = true
	}
	return &d.messages[d.openTurn]
}

func beginTurn(d *draft, id, openedBy string) {
	d.messages = append(d.messages, ViewMessage{Kind: "turn", ID: id, OpenedBy: openedBy, Sections: []ViewSection{}})
	d.openTurn = len(d.messages) - 1
	d.turnCloned = true
}

// stampTurnOutcome: a lone end still gets an outcome-only segment when input sealed the last one.
func stampTurnOutcome(d *draft, id string, outcome oar.TurnOutcome) {
	if d.openTurn == -1 {
		beginTurn(d, id, "")
	}
	if turn := turnForWrite(d); turn != nil {
		turn.Outcome = &outcome
	}
}

// sealTurn seals the current segment without an outcome; later content opens a new one.
func sealTurn(d *draft) {
	d.openTurn = -1
	d.turnCloned = false
}

// sectionFor is the last section of the open turn when it matches the lane,
// else a new one. The pointer is valid until the next change to the turn.
func sectionFor(d *draft, sessionID string, agentPath []string) *ViewSection {
	turn := turnForWrite(d)
	if turn == nil {
		return nil
	}
	if n := len(turn.Sections); n > 0 && sectionInLane(turn.Sections[n-1], sessionID, agentPath) {
		cloned := turn.Sections[n-1]
		cloned.Parts = slices.Clone(nonNilSlice(cloned.Parts))
		turn.Sections[n-1] = cloned
		return &turn.Sections[n-1]
	}
	turn.Sections = append(turn.Sections, ViewSection{SessionID: sessionID, AgentPath: pathOrEmpty(agentPath), Parts: []ViewPart{}})
	return &turn.Sections[len(turn.Sections)-1]
}

// laneFor opens a segment when none is running, then gives the event's lane.
func laneFor(d *draft, event oar.Event, streamID string) *ViewSection {
	if d.openTurn == -1 {
		beginTurn(d, turnID(streamID, event.SessionID, event.Seq), "")
	}
	return sectionFor(d, event.SessionID, event.AgentPath)
}

func pushPart(section *ViewSection, part ViewPart) {
	if section != nil {
		section.Parts = append(section.Parts, part)
	}
}

func noticePart(d *draft, event oar.Event, streamID string, notice ViewNotice) {
	pushPart(laneFor(d, event, streamID), ViewPart{Kind: "notice", Notice: &notice})
}

// updateRequestPart rewrites the part that shows requestID, latest turn first; nothing when no part shows it.
func updateRequestPart(d *draft, requestID string, change func(ViewPart) ViewPart) {
	for m := len(d.messages) - 1; m >= 0; m-- {
		message := d.messages[m]
		if message.Kind != "turn" {
			continue
		}
		for s, section := range message.Sections {
			index := slices.IndexFunc(section.Parts, func(part ViewPart) bool { return part.Kind == "app_request" && part.RequestID == requestID })
			if index == -1 {
				continue
			}
			parts := slices.Clone(section.Parts)
			parts[index] = change(parts[index])
			sections := slices.Clone(message.Sections)
			section.Parts = parts
			sections[s] = section
			message.Sections = sections
			d.messages[m] = message
			if m == d.openTurn {
				d.turnCloned = false
			}
			return
		}
	}
}

func dropPending(d *draft, requestID string) {
	if index := slices.IndexFunc(d.pendingRequests, func(request PendingRequest) bool { return request.RequestID == requestID }); index != -1 {
		d.pendingRequests = slices.Delete(d.pendingRequests, index, index+1)
	}
}

func markRequestAnswered(d *draft, requestID string) {
	dropPending(d, requestID)
	updateRequestPart(d, requestID, func(part ViewPart) ViewPart {
		part.Answered = true
		return part
	})
}

// markRequestCancelled: the runtime withdrew the request; nobody is waited on for it any more.
func markRequestCancelled(d *draft, requestID string) {
	dropPending(d, requestID)
	updateRequestPart(d, requestID, func(part ViewPart) ViewPart {
		part.Cancelled = true
		return part
	})
}

// removeEmptyTurn drops a turn the runtime says never began (rejected prompt), when still empty.
func removeEmptyTurn(d *draft, requestID string) {
	if d.openTurn == -1 {
		return
	}
	message := d.messages[d.openTurn]
	if message.Kind == "turn" && message.OpenedBy == requestID && len(message.Sections) == 0 {
		d.messages = slices.Delete(d.messages, d.openTurn, d.openTurn+1)
		d.openTurn = -1
		d.turnCloned = false
	}
}
