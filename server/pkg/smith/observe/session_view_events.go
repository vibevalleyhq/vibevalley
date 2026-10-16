package observe

import (
	"encoding/json"
	"slices"
	"strconv"

	"vibevalley/pkg/smith/oar"
)

// The event-level fold of the session view (observe/session-view-events.ts):
// one Event (or one record's record-level facts in recordFacts) applied to
// the draft.

func turnID(streamID, sessionID string, seq int64) string {
	return "turn:" + streamID + ":" + sessionID + ":" + strconv.FormatInt(seq, 10)
}

func noticeID(streamID, sessionID string, seq int64) string {
	return "nt:" + streamID + ":" + sessionID + ":" + strconv.FormatInt(seq, 10)
}

func foldEvent(d *draft, event oar.Event, streamID, openedBy string) {
	scope := d.rootSessionID
	if scope == "" {
		scope = event.SessionID
	}
	rootAgent := len(event.AgentPath) == 0
	switch e := event.Body.(type) {
	case oar.UserMessage, oar.InputDropped, oar.InputQueued:
		// Native echoes are ConversationInput observations, never a second bubble.
		return
	case oar.TurnStarted:
		beginTurn(d, "turn:"+streamID+":"+e.RequestID, e.RequestID)
	case oar.TurnActive:
		if event.SessionID == scope && rootAgent && d.openTurn == -1 {
			beginTurn(d, turnID(streamID, event.SessionID, event.Seq), openedBy)
		}
	case oar.TextDelta:
		if appendMessageText(d, event) {
			return
		}
		section := laneFor(d, event, streamID)
		if section == nil {
			return
		}
		// Unnamed text retains stream order (older records, pi, ACP).
		if n := len(section.Parts); n > 0 && section.Parts[n-1].Kind == "text" && e.MessageID == "" {
			section.Parts[n-1].Text += e.Text
		} else {
			section.Parts = append(section.Parts, ViewPart{Kind: "text", Text: e.Text, MessageID: e.MessageID})
		}
	case oar.Reasoning:
		if appendMessageText(d, event) {
			return
		}
		section := laneFor(d, event, streamID)
		if section == nil {
			return
		}
		if n := len(section.Parts); n > 0 && e.MessageID == "" && section.Parts[n-1].Kind == "reasoning" && section.Parts[n-1].Content.Kind == "text" && e.Content.Kind == "text" {
			section.Parts[n-1].Content = oar.ReasoningContent{Kind: "text", Text: section.Parts[n-1].Content.Text + e.Content.Text}
		} else {
			section.Parts = append(section.Parts, ViewPart{Kind: "reasoning", Content: e.Content, MessageID: e.MessageID})
		}
	case oar.ToolCallStarted:
		at := event.ReceivedAt
		pushPart(laneFor(d, event, streamID), ViewPart{Kind: "tool", CallID: e.CallID, Tool: e.Tool, Input: e.Input, Result: "running", StartedAt: &at})
	case oar.ToolCallInput:
		if updateToolInput(d, event) {
			return
		}
		// An input without a start is still a fact (mid-turn subscriber).
		input := e.Input
		pushPart(laneFor(d, event, streamID), ViewPart{Kind: "tool", CallID: e.CallID, Tool: "?", Input: &input, Result: "running"})
	case oar.ToolCallInputDelta:
		if updateToolInput(d, event) {
			return
		}
		input := e.Delta
		pushPart(laneFor(d, event, streamID), ViewPart{Kind: "tool", CallID: e.CallID, Tool: "?", Input: &input, InputPartial: true, Result: "running"})
	case oar.ToolCallProgress:
		if updateToolPart(d, event, "running") {
			return
		}
		// A progress without a start is still a fact (mid-turn subscriber).
		pushPart(laneFor(d, event, streamID), ViewPart{Kind: "tool", CallID: e.CallID, Tool: "?", Output: toolPreview(nil, e), Result: "running"})
	case oar.ToolCallEnded:
		result := e.Result
		if result == "" {
			result = "ended"
		}
		if updateToolPart(d, event, result) {
			return
		}
		// An end without a start is still a fact (mid-turn subscriber).
		at := event.ReceivedAt
		pushPart(laneFor(d, event, streamID), ViewPart{Kind: "tool", CallID: e.CallID, Tool: "?", ToolContent: e.Content, Result: result, EndedAt: &at})
	case oar.TurnEnded:
		if event.SessionID == scope && rootAgent {
			endRootTools(d, scope)
			stampTurnOutcome(d, turnID(streamID, event.SessionID, event.Seq), e.Outcome)
			sealTurn(d)
		} else {
			noticePart(d, event, streamID, ViewNotice{Cause: "child_turn_ended", Outcome: e.Outcome})
		}
	case oar.CompactionStarted:
		noticePart(d, event, streamID, ViewNotice{Cause: "compaction_started", Trigger: e.Trigger})
	case oar.CompactionEnded:
		noticePart(d, event, streamID, ViewNotice{Cause: "compaction_ended", CompactionOutcome: e.Outcome, Trigger: e.Trigger, Reason: e.Reason})
	case oar.Retry:
		noticePart(d, event, streamID, ViewNotice{Cause: "retry", Attempt: e.Attempt, MaxAttempts: e.MaxAttempts, DelayMs: e.DelayMs, Reason: e.Reason})
	case oar.AppRequest:
		if !slices.ContainsFunc(d.pendingRequests, func(request PendingRequest) bool { return request.RequestID == e.RequestID }) {
			d.pendingRequests = append(d.pendingRequests, PendingRequest{RequestID: e.RequestID, Type: e.Type, SessionID: event.SessionID, AgentPath: pathOrEmpty(event.AgentPath), Seq: event.Seq})
		}
		pushPart(laneFor(d, event, streamID), ViewPart{Kind: "app_request", RequestID: e.RequestID, Type: e.Type})
	case oar.AppAnswered:
		markRequestAnswered(d, e.RequestID)
	case oar.AppRequestCancelled:
		markRequestCancelled(d, e.RequestID)
	case oar.ControlRejected:
		notice := ViewNotice{Cause: "control_rejected", Action: e.Action, Reason: e.Reason}
		switch {
		case e.Action == oar.ActionPrompt:
			removeEmptyTurn(d, e.RequestID)
		case d.openTurn != -1:
			noticePart(d, event, streamID, notice)
		default:
			d.messages = append(d.messages, ViewMessage{Kind: "notice", ID: noticeID(streamID, event.SessionID, event.Seq), Notice: &notice})
		}
	case oar.Exited:
		notice := ViewNotice{Cause: "exited", Code: e.Code}
		if event.SessionID != scope || !rootAgent {
			noticePart(d, event, streamID, notice)
			return
		}
		endRootTools(d, scope)
		// Whoever asked is gone with the process: nobody is waited on any more.
		d.pendingRequests = []PendingRequest{}
		d.exited = &ExitInfo{Code: e.Code}
		d.messages = append(d.messages, ViewMessage{Kind: "notice", ID: noticeID(streamID, event.SessionID, event.Seq), Notice: &notice})
		sealTurn(d)
	case oar.SessionLinked:
		d.sessionGraph = withSessionLink(d.sessionGraph, oar.SessionEdge{Parent: e.Parent, Child: e.Child, Via: e.Via})
	case oar.Usage:
		previous, _ := d.usageBySession.get(event.SessionID)
		d.usageBySession.set(event.SessionID, FoldSessionTokens(previous, pathOrEmpty(event.AgentPath), e.Usage))
		if event.SessionID == scope && e.Usage.Context != nil && rootAgent {
			d.context = e.Usage.Context
		}
	case oar.Model:
		if event.SessionID == scope && rootAgent {
			model := e.Model
			d.model = &model
		}
	case oar.ServiceTier:
		if event.SessionID == scope && rootAgent {
			tier := e.ServiceTier
			d.serviceTier = &tier
		}
	case oar.Effort:
		if event.SessionID == scope && rootAgent {
			effort := e.Effort
			d.effort = &effort
		}
	case oar.TaskStarted, oar.TaskUpdated, oar.TaskEnded:
		// Tasks are not transcript content; TasksOf folds them for a task panel.
	case oar.InputWithdrawn:
		// Input facts reach the view as conversation updates: a withdrawn input
		// leaves the lists there. A withdraw of an input never folded has nothing to remove.
	}
}

// appendMessageText: named text rejoins its own part, only inside the current unsealed segment.
func appendMessageText(d *draft, event oar.Event) bool {
	messageID := messageIDOf(event)
	if messageID == "" {
		return false
	}
	reasoning, isReasoning := event.Body.(oar.Reasoning)
	if isReasoning && reasoning.Content.Kind != "text" {
		return false
	}
	turn := turnForWrite(d)
	if turn == nil {
		return false
	}
	for s := len(turn.Sections) - 1; s >= 0; s-- {
		section := turn.Sections[s]
		if !sectionInLane(section, event.SessionID, event.AgentPath) {
			continue
		}
		for p := len(section.Parts) - 1; p >= 0; p-- {
			part := section.Parts[p]
			updated := false
			switch body := event.Body.(type) {
			case oar.TextDelta:
				if part.Kind == "text" && part.MessageID == body.MessageID {
					part.Text += body.Text
					updated = true
				}
			case oar.Reasoning:
				if part.Kind == "reasoning" && part.MessageID == body.MessageID && part.Content.Kind == "text" {
					part.Content = oar.ReasoningContent{Kind: "text", Text: part.Content.Text + body.Content.Text}
					updated = true
				}
			}
			if !updated {
				continue
			}
			parts := slices.Clone(section.Parts)
			parts[p] = part
			section.Parts = parts
			turn.Sections[s] = section
			return true
		}
	}
	return false
}

// ─── Record-level facts the flat event reading does not carry ─────────────

func recordFacts(d *draft, record oar.RawEvent, streamID string) {
	if record.Kind == oar.KindRequest && record.Direction == oar.ToApp {
		entry := PendingRequest{RequestID: record.ID, Type: string(record.Request.Kind), SessionID: record.SessionID, AgentPath: pathOrEmpty(record.AgentPath), Seq: record.Seq, HasBody: true}
		if record.Request.Kind == oar.RequestNative {
			entry.Type = record.Request.Type
			entry.Body = rawOrNull(record.Request.Native)
		} else {
			body, _ := json.Marshal(record.Request)
			entry.Body = body
		}
		if existing := slices.IndexFunc(d.pendingRequests, func(request PendingRequest) bool { return request.RequestID == record.ID }); existing == -1 {
			d.pendingRequests = append(d.pendingRequests, entry)
		} else {
			d.pendingRequests[existing] = entry
		}
		// The part was pushed from the flat event, which has no body.
		updateRequestPart(d, record.ID, func(part ViewPart) ViewPart {
			part.HasBody = true
			part.Body = entry.Body
			return part
		})
		return
	}
	if record.Kind == oar.KindRequest && record.Direction == oar.ToRuntime && record.Request.Kind == oar.RequestPrompt {
		// After the input update landed: the turn opens below its own bubble.
		beginTurn(d, "turn:"+streamID+":"+record.ID, record.ID)
		return
	}
	if record.Kind == oar.KindResponse && record.Response.Kind == oar.ResponseRejected && d.openTurn != -1 {
		removeEmptyTurn(d, record.RequestID)
	}
}
