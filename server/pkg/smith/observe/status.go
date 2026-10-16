// Package observe holds consumer-side derivations over the record stream
// (packages/oar/src/observe): the status fold, the events reading, usage
// folds, turn helpers. Pure functions over records; no I/O.
package observe

import (
	"slices"

	"vibevalley/pkg/smith/oar"
)

// InitialStatus is idle with nothing known.
var InitialStatus = oar.AgentStatus{Kind: "idle"}

// StatusOf folds a retained log (Session.Status). sessionID scopes the fold
// to one session's root agent; "" folds every root-agent record.
func StatusOf(records []oar.RawEvent, sessionID string) oar.QueryResult[oar.AgentStatus] {
	value := InitialStatus
	seq := int64(-1)
	for _, record := range records {
		value = ReduceStatus(value, record, sessionID)
		seq = record.Seq
	}
	return oar.QueryResult[oar.AgentStatus]{Value: value, Seq: seq}
}

func running(previous oar.AgentStatus, record oar.RawEvent, phase oar.RunningPhase) oar.AgentStatus {
	next := oar.AgentStatus{Kind: "running", SinceSeq: record.Seq, Phase: phase, LastEventAt: record.ReceivedAt, PendingPrompt: previous.PendingPrompt}
	if previous.IsRunning() {
		next.SinceSeq = previous.SinceSeq
		next.RequestID = previous.RequestID
		next.Stop = previous.Stop
		next.InputID = previous.InputID
	}
	return next
}

func touched(previous oar.AgentStatus, record oar.RawEvent) oar.AgentStatus {
	if previous.IsRunning() {
		previous.LastEventAt = record.ReceivedAt
	}
	return previous
}

// ReduceStatus is one step of the status fold (observe/agent-status.ts).
func ReduceStatus(previous oar.AgentStatus, record oar.RawEvent, sessionID string) oar.AgentStatus {
	foreignSession := sessionID != "" && record.SessionID != sessionID
	if foreignSession || len(record.AgentPath) > 0 || (record.Kind == oar.KindFrame && len(record.Frame.Events) == 0) {
		// A child agent, a child session, or a frame OAR read nothing from:
		// the session is alive, so the clock moves, but the root's phase does not.
		return touched(previous, record)
	}
	if pending := previous.PendingPrompt; pending != nil && (previous.Kind == "idle" || previous.InputID == pending.InputID ||
		(record.Kind == oar.KindRequest && record.Request.Kind == oar.RequestDispose) ||
		(record.Kind == oar.KindResponse && pending.Stop != nil && slices.Contains(pending.Stop.PendingAbortIDs, record.RequestID))) {
		stop := ReduceTurnStop(pending.Stop, record)
		if stop != pending.Stop {
			copied := *pending
			copied.Stop = stop
			previous.PendingPrompt = &copied
		}
	}
	if previous.IsRunning() {
		stop := ReduceTurnStop(previous.Stop, record)
		if stop != previous.Stop {
			previous.Stop = stop
		}
	}
	switch record.Kind {
	case oar.KindRequest:
		if record.Direction == oar.ToRuntime && record.Request.Kind == oar.RequestPrompt && previous.Kind == "idle" && previous.PendingPrompt == nil {
			return oar.AgentStatus{Kind: "running", SinceSeq: record.Seq, RequestID: record.ID, InputID: record.Request.InputID, Phase: oar.PhaseWaitingModel, LastEventAt: record.ReceivedAt}
		}
		return previous
	case oar.KindResponse:
		if record.Response.Kind == oar.ResponseRejected && previous.IsRunning() && previous.RequestID == record.RequestID {
			return oar.AgentStatus{Kind: "idle"}
		}
		if record.Response.Kind == oar.ResponseExited && previous.Kind == "idle" {
			return oar.AgentStatus{Kind: "idle", LastTurnOutcome: previous.LastTurnOutcome}
		}
		if record.Response.Kind == oar.ResponseExited && previous.IsRunning() {
			outcome := ExitTurnOutcome(previous.Stop)
			return oar.AgentStatus{Kind: "idle", LastTurnOutcome: &outcome}
		}
		return previous
	case oar.KindFrame:
		status := previous
		for _, event := range record.Frame.Events {
			status = reduceEvent(status, record, event)
		}
		return status
	}
	return previous
}

func reduceEvent(previous oar.AgentStatus, record oar.RawEvent, event oar.EventBody) oar.AgentStatus {
	switch e := event.(type) {
	case oar.InputQueued:
		own := previous.IsRunning() && previous.InputID == e.InputID
		pending := &oar.PendingPrompt{InputID: e.InputID, SinceSeq: record.Seq}
		if own {
			pending.SinceSeq = previous.SinceSeq
			pending.RequestID = previous.RequestID
			pending.Stop = previous.Stop
		}
		next := previous
		next.PendingPrompt = pending
		if previous.IsRunning() {
			next.LastEventAt = record.ReceivedAt
		}
		return next
	case oar.TurnActive:
		if e.InputID != "" && previous.PendingPrompt != nil && previous.PendingPrompt.InputID == e.InputID {
			return waitingForPrompt(*previous.PendingPrompt, record, false)
		}
		if previous.PendingPrompt != nil && (previous.Kind == "idle" || previous.InputID == previous.PendingPrompt.InputID) {
			return oar.AgentStatus{Kind: "running", SinceSeq: record.Seq, Phase: oar.PhaseWaitingModel, LastEventAt: record.ReceivedAt, PendingPrompt: previous.PendingPrompt}
		}
		if previous.IsRunning() {
			return touched(previous, record)
		}
		return running(previous, record, oar.PhaseWaitingModel)
	case oar.Reasoning:
		return running(previous, record, oar.PhaseThinking)
	case oar.TextDelta:
		return running(previous, record, oar.PhaseResponding)
	case oar.ToolCallStarted:
		return running(previous, record, oar.ToolPhase(e.Tool, e.CallID))
	case oar.ToolCallEnded, oar.Retry:
		return running(previous, record, oar.PhaseWaitingModel)
	case oar.CompactionEnded:
		if previous.IsRunning() {
			return running(previous, record, oar.PhaseWaitingModel)
		}
		return previous
	case oar.CompactionStarted:
		return running(previous, record, oar.PhaseCompacting)
	case oar.ToolCallInputDelta:
		return toolInput(previous, record, e.CallID, true)
	case oar.ToolCallInput:
		return toolInput(previous, record, e.CallID, false)
	case oar.ToolCallProgress:
		return touched(previous, record)
	case oar.TurnEnded:
		if previous.PendingPrompt == nil {
			outcome := e.Outcome
			return oar.AgentStatus{Kind: "idle", LastTurnOutcome: &outcome}
		}
		return waitingForPrompt(*previous.PendingPrompt, record, true)
	case oar.TaskStarted, oar.TaskUpdated, oar.TaskEnded:
		return touched(previous, record)
	case oar.InputDropped:
		if previous.IsRunning() && previous.InputID == e.InputID {
			return oar.AgentStatus{Kind: "idle"}
		}
		if previous.PendingPrompt == nil || previous.PendingPrompt.InputID != e.InputID {
			return previous
		}
		previous.PendingPrompt = nil
		return previous
	}
	return previous
}

func toolInput(previous oar.AgentStatus, record oar.RawEvent, callID string, writing bool) oar.AgentStatus {
	if !previous.IsRunning() {
		return previous
	}
	if previous.Phase.IsTool() && previous.Phase.CallID == callID {
		previous.Phase = oar.RunningPhase{Tool: previous.Phase.Tool, CallID: previous.Phase.CallID, Writing: writing}
	}
	previous.LastEventAt = record.ReceivedAt
	return previous
}

// waitingForPrompt: a notification can finish while the accepted host input still owns the slot.
func waitingForPrompt(pending oar.PendingPrompt, record oar.RawEvent, keepPending bool) oar.AgentStatus {
	status := oar.AgentStatus{Kind: "running", SinceSeq: pending.SinceSeq, InputID: pending.InputID, RequestID: pending.RequestID, Stop: pending.Stop, Phase: oar.PhaseWaitingModel, LastEventAt: record.ReceivedAt}
	if keepPending {
		copied := pending
		status.PendingPrompt = &copied
	}
	return status
}

// Stall is how long a running status has been silent.
type Stall struct {
	SinceSeq    int64 `json:"sinceSeq"`
	SilentForMs int64 `json:"silentForMs"`
}

// StallOf is fold × clock: the silence of a running status beyond the threshold, or nil.
func StallOf(status oar.AgentStatus, nowMs, thresholdMs int64) *Stall {
	if !status.IsRunning() {
		return nil
	}
	silent := nowMs - status.LastEventAt
	if silent < thresholdMs {
		return nil
	}
	return &Stall{SinceSeq: status.SinceSeq, SilentForMs: silent}
}

// ReduceTurnStop folds only the current root turn's controls (observe/turn-stop.ts).
// It returns the same pointer when nothing changed.
func ReduceTurnStop(previous *oar.TurnStop, record oar.RawEvent) *oar.TurnStop {
	var pending []string
	aborted := false
	if previous != nil {
		pending = previous.PendingAbortIDs
		aborted = previous.AbortedOnExit
	}
	if record.Kind == oar.KindRequest && record.Direction == oar.ToRuntime {
		if record.Request.Kind == oar.RequestDispose {
			return &oar.TurnStop{PendingAbortIDs: nonNilStrings(pending), AbortedOnExit: true}
		}
		if record.Request.Kind == oar.RequestAbort {
			return &oar.TurnStop{PendingAbortIDs: append(slices.Clone(nonNilStrings(pending)), record.ID), AbortedOnExit: aborted}
		}
	}
	if record.Kind == oar.KindResponse && (record.Response.Kind == oar.ResponseAccepted || record.Response.Kind == oar.ResponseRejected) && slices.Contains(pending, record.RequestID) {
		remaining := []string{}
		for _, id := range pending {
			if id != record.RequestID {
				remaining = append(remaining, id)
			}
		}
		abortedOnExit := aborted || record.Response.Kind == oar.ResponseAccepted
		if len(remaining) == 0 && !abortedOnExit {
			return nil
		}
		return &oar.TurnStop{PendingAbortIDs: remaining, AbortedOnExit: abortedOnExit}
	}
	return previous
}

func nonNilStrings(values []string) []string {
	if values == nil {
		return []string{}
	}
	return values
}

// ExitTurnOutcome: an observed exit ends stopped work as aborted, else as failed runtime_exited.
func ExitTurnOutcome(stop *oar.TurnStop) oar.TurnOutcome {
	if stop != nil && stop.AbortedOnExit {
		return oar.AbortedOutcome()
	}
	return oar.Failed(oar.FailureRuntimeExited, "runtime exited")
}
