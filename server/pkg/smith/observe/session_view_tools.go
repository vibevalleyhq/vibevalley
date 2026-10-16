package observe

import (
	"slices"

	"vibevalley/pkg/smith/oar"
)

// Tool parts of the session view (observe/session-view-tools.ts).

// endRootTools: a root turn boundary ends its unresolved calls, without
// claiming a result or a native tool end time. Inputs may have split the turn
// into segments; walk back to its prompt, the preceding outcome, or the
// preceding exit.
func endRootTools(d *draft, sessionID string) {
	for index := len(d.messages) - 1; index >= 0; index-- {
		message := d.messages[index]
		if message.Kind == "notice" && message.Notice != nil && message.Notice.Cause == "exited" {
			break
		}
		if message.Kind != "turn" {
			continue
		}
		// The record fold may already have stamped this segment's exit outcome.
		if index != d.openTurn && message.Outcome != nil {
			break
		}
		var sections []ViewSection
		for s, section := range message.Sections {
			ended, changed := endRootSectionTools(section, sessionID)
			if changed && sections == nil {
				sections = slices.Clone(message.Sections)
			}
			if sections != nil {
				sections[s] = ended
			}
		}
		if sections != nil {
			message.Sections = sections
			d.messages[index] = message
			if index == d.openTurn {
				d.turnCloned = false
			}
		}
		if message.OpenedBy != "" {
			break
		}
	}
}

func endRootSectionTools(section ViewSection, sessionID string) (ViewSection, bool) {
	if !sectionInLane(section, sessionID, nil) || !slices.ContainsFunc(section.Parts, func(part ViewPart) bool { return part.Kind == "tool" && part.Result == "running" }) {
		return section, false
	}
	parts := make([]ViewPart, len(section.Parts))
	for i, part := range section.Parts {
		if part.Kind == "tool" && part.Result == "running" {
			part.ToolContent = nil
			part.Result = "ended"
		}
		parts[i] = part
	}
	section.Parts = parts
	return section, true
}

// toolPreview: a snapshot replaces the current preview; a delta appends to it.
func toolPreview(previous *string, event oar.ToolCallProgress) *string {
	snapshot := previous
	if event.Output != nil {
		snapshot = event.Output
	}
	if event.OutputDelta == nil {
		return snapshot
	}
	output := *event.OutputDelta
	if snapshot != nil {
		output = *snapshot + output
	}
	return &output
}

// updateToolPart settles a call's tool part in place, in whichever turn its
// start landed (one part per lane and callId): a runtime may report a call's
// last output after its turn ended. False when no part holds the callId.
func updateToolPart(d *draft, event oar.Event, result string) bool {
	return replaceToolPart(d, event, toolCallIDOf(event.Body), func(part ViewPart) ViewPart {
		switch body := event.Body.(type) {
		case oar.ToolCallEnded:
			// The streamed preview gives way to the result.
			part.Output = nil
			if body.Content != nil {
				part.ToolContent = body.Content
			}
			part.Result = result
			at := event.ReceivedAt
			part.EndedAt = &at
		case oar.ToolCallProgress:
			// A late output delta adds evidence; it cannot reopen an ended call.
			part.Output = toolPreview(part.Output, body)
		}
		return part
	})
}

// updateToolInput appends raw fragments, or replaces them with the complete
// input, without changing the call's state. False when no part holds the callId.
func updateToolInput(d *draft, event oar.Event) bool {
	return replaceToolPart(d, event, toolCallIDOf(event.Body), func(part ViewPart) ViewPart {
		switch body := event.Body.(type) {
		case oar.ToolCallInputDelta:
			input := body.Delta
			if part.Input != nil {
				input = *part.Input + body.Delta
			}
			part.Input = &input
			part.InputPartial = true
		case oar.ToolCallInput:
			input := body.Input
			part.Input = &input
			part.InputPartial = false
		}
		return part
	})
}

func toolCallIDOf(body oar.EventBody) string {
	switch e := body.(type) {
	case oar.ToolCallEnded:
		return e.CallID
	case oar.ToolCallProgress:
		return e.CallID
	case oar.ToolCallInput:
		return e.CallID
	case oar.ToolCallInputDelta:
		return e.CallID
	case oar.ToolCallStarted:
		return e.CallID
	}
	return ""
}

func replaceToolPart(d *draft, event oar.Event, callID string, next func(ViewPart) ViewPart) bool {
	for m := len(d.messages) - 1; m >= 0; m-- {
		message := d.messages[m]
		if message.Kind != "turn" {
			continue
		}
		for s := len(message.Sections) - 1; s >= 0; s-- {
			section := message.Sections[s]
			if !sectionInLane(section, event.SessionID, event.AgentPath) {
				continue
			}
			index := slices.IndexFunc(section.Parts, func(part ViewPart) bool { return part.Kind == "tool" && part.CallID == callID })
			if index == -1 {
				continue
			}
			parts := slices.Clone(section.Parts)
			parts[index] = next(parts[index])
			sections := slices.Clone(message.Sections)
			section.Parts = parts
			sections[s] = section
			message.Sections = sections
			d.messages[m] = message
			if m == d.openTurn {
				d.turnCloned = false
			}
			return true
		}
	}
	return false
}
