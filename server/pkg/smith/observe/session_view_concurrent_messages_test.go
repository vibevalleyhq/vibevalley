package observe_test

import (
	"encoding/json"
	"fmt"
	"testing"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Port of tests/session-view-concurrent-messages.test.ts.

var (
	svRootLane       = svLane{Session: "root", At: 1}
	svChildSession   = svLane{Session: "child", At: 1}
	svChildAgentLane = svLane{Session: "root", Path: []string{"toolu_agent"}, At: 1}
)

func svCMRequest(seq int64, kind oar.RequestKind) oar.RawEvent {
	return svRequestIn(svRootLane, seq, fmt.Sprintf("r%d", seq), oar.ToRuntime, oar.RequestBody{Kind: kind, Input: "go", InputID: fmt.Sprintf("i%d", seq)})
}

func svCMText(value, messageID string) oar.EventBody {
	return oar.TextDelta{Text: value, MessageID: messageID}
}

func svCMReasoning(value, messageID string) oar.EventBody {
	return oar.Reasoning{Content: oar.ReasoningContent{Kind: "text", Text: value}, MessageID: messageID}
}

func svPartSummary(part observe.ViewPart) string {
	name := func(id string) string {
		if id == "" {
			return "unnamed"
		}
		return id
	}
	switch part.Kind {
	case "text":
		return fmt.Sprintf("text(%s): %s", name(part.MessageID), part.Text)
	case "reasoning":
		if part.Content.Kind == "text" {
			return fmt.Sprintf("reasoning(%s): %s", name(part.MessageID), part.Content.Text)
		}
		return fmt.Sprintf("reasoning(%s): [%s]", name(part.MessageID), part.Content.Kind)
	case "tool":
		return fmt.Sprintf("tool(%s): %s", part.CallID, part.Tool)
	case "notice":
		return "notice: " + part.Notice.Cause
	case "app_request":
		return "app_request: " + part.RequestID
	}
	return "?"
}

func svPartsBySection(view observe.SessionView) [][][]string {
	out := [][][]string{}
	for _, turn := range svTurns(view) {
		sections := [][]string{}
		for _, section := range turn.Sections {
			parts := []string{}
			for _, part := range section.Parts {
				parts = append(parts, svPartSummary(part))
			}
			sections = append(sections, parts)
		}
		out = append(out, sections)
	}
	return out
}

func svView(records ...oar.RawEvent) observe.SessionView { return observe.ViewOf(records, "") }

func TestSessionViewConcurrentChildSessionMessagesStayWhole(t *testing.T) {
	view := svView(
		svCMRequest(0, oar.RequestPrompt),
		svFrameIn(svChildSession, 1, svCMText("A1", "m_child")),
		svFrameIn(svRootLane, 2, svCMText("B1", "m_root")),
		svFrameIn(svChildSession, 3, svCMText("A2", "m_child")),
		svFrameIn(svRootLane, 4, svCMText("B2", "m_root")),
	)
	sections := [][]observe.ViewSection{}
	for _, turn := range svTurns(view) {
		sections = append(sections, turn.Sections)
	}
	svEq(t, "sections", sections, `[[
		{"agentPath":[],"parts":[{"kind":"text","messageId":"m_child","text":"A1A2"}],"sessionId":"child"},
		{"agentPath":[],"parts":[{"kind":"text","messageId":"m_root","text":"B1B2"}],"sessionId":"root"}]]`)
}

func TestSessionViewConcurrentEqualIDsStayScopedToTheirLane(t *testing.T) {
	for _, child := range []svLane{svChildSession, svChildAgentLane, {Session: "root", Path: []string{"nested", "agent"}, At: 1}} {
		t.Run(fmt.Sprintf("%v", child), func(t *testing.T) {
			view := svView(
				svCMRequest(0, oar.RequestPrompt),
				svFrameIn(child, 1, svCMText("A1", "same"), svCMReasoning("R1", "same")),
				svFrameIn(svRootLane, 2, svCMText("B1", "same"), svCMReasoning("S1", "same")),
				svFrameIn(child, 3, svCMText("A2", "same"), svCMReasoning("R2", "same")),
				svFrameIn(svRootLane, 4, svCMText("B2", "same"), svCMReasoning("S2", "same")),
			)
			lanes := []any{}
			for _, section := range svTurns(view)[0].Sections {
				lanes = append(lanes, map[string]any{"sessionId": section.SessionID, "agentPath": section.AgentPath})
			}
			path := child.Path
			if path == nil {
				path = []string{}
			}
			wantPath, _ := json.Marshal(path)
			svEq(t, "lanes", lanes, fmt.Sprintf(`[{"sessionId":%q,"agentPath":%s},{"sessionId":"root","agentPath":[]}]`, child.Session, wantPath))
			svEq(t, "parts", svPartsBySection(view), `[[["text(same): A1A2","reasoning(same): R1R2"],["text(same): B1B2","reasoning(same): S1S2"]]]`)
		})
	}
}

func TestSessionViewConcurrentNamedPartsRejoinPastOtherParts(t *testing.T) {
	view := svView(
		svCMRequest(0, oar.RequestPrompt),
		svFrameIn(svRootLane, 1, svCMText("A1", "a"), svCMReasoning("R1", "a")),
		svFrameIn(svRootLane, 2, oar.ToolCallStarted{CallID: "call", Tool: "Read"}),
		svFrameIn(svRootLane, 3, oar.Retry{Attempt: 1}, svCMText("B1", "b"), svCMReasoning("S1", "b")),
		svFrameIn(svRootLane, 4, svCMText("A2", "a"), svCMReasoning("R2", "a")),
	)
	svEq(t, "parts", svPartsBySection(view), `[[["text(a): A1A2","reasoning(a): R1R2","tool(call): Read","notice: retry","text(b): B1","reasoning(b): S1"]]]`)
}

func TestSessionViewConcurrentNamedReasoningKeepsIDsAndLifecycleFacts(t *testing.T) {
	view := svView(
		svCMRequest(0, oar.RequestPrompt),
		svFrameIn(svRootLane, 1, svCMReasoning("A1", "a"), svCMReasoning("B1", "b")),
		svFrameIn(svRootLane, 2, oar.Reasoning{Content: oar.ReasoningContent{Kind: "redacted"}, MessageID: "a"}),
		svFrameIn(svRootLane, 3, oar.Reasoning{Content: oar.ReasoningContent{Kind: "empty"}, MessageID: "a"}),
		svFrameIn(svRootLane, 4, svCMReasoning("A2", "a"), svCMReasoning("B2", "b")),
	)
	svEq(t, "parts", svPartsBySection(view), `[[["reasoning(a): A1A2","reasoning(b): B1B2","reasoning(a): [redacted]","reasoning(a): [empty]"]]]`)
}

func svBeforeInput(echoes bool) []oar.RawEvent {
	records := []oar.RawEvent{svCMRequest(0, oar.RequestPrompt)}
	if echoes {
		records = append(records, svFrameIn(svRootLane, 1, oar.UserMessage{Input: "go", InputID: "i0", Evidence: "acknowledged"}))
	}
	return append(records,
		svFrameIn(svRootLane, 2, svCMText("before", "m"), svCMReasoning("before", "m")),
		svFrameIn(svChildAgentLane, 3, svCMText("child before", "child")),
		svCMRequest(4, oar.RequestSteer),
	)
}

func TestSessionViewConcurrentMessagesStartNewPartsAfterAnInputSeal(t *testing.T) {
	for _, echoes := range []bool{false, true} {
		t.Run(fmt.Sprintf("echoes=%v", echoes), func(t *testing.T) {
			before := svBeforeInput(echoes)
			if sealed := svView(before...).OpenTurn == -1; sealed != !echoes {
				t.Errorf("sealed = %v", sealed)
			}
			records := append([]oar.RawEvent{}, before...)
			if echoes {
				records = append(records, svFrameIn(svRootLane, 5, oar.UserMessage{Input: "go", InputID: "i4", Evidence: "acknowledged"}))
			}
			records = append(records,
				svFrameIn(svRootLane, 6, svCMText("after", "m"), svCMReasoning("after", "m")),
				svFrameIn(svChildAgentLane, 7, svCMText("child after", "child")),
				svFrameIn(svRootLane, 8, svCMText("!", "m"), svCMReasoning("!", "m")),
			)
			view := svView(records...)
			svEq(t, "kinds", svKinds(view), `["input","turn","input","turn"]`)
			svEq(t, "parts", svPartsBySection(view), `[[["text(m): before","reasoning(m): before"],["text(child): child before"]],
				[["text(m): after!","reasoning(m): after!"],["text(child): child after"]]]`)
		})
	}
}

func TestSessionViewConcurrentUnnamedPartsAppendInLaneOrder(t *testing.T) {
	view := svView(
		svCMRequest(0, oar.RequestPrompt),
		svFrameIn(svChildAgentLane, 1, svCMText("A1", ""), svCMReasoning("R1", "")),
		svFrameIn(svRootLane, 2, svCMText("B1", "")),
		svFrameIn(svChildAgentLane, 3, svCMText("A2", ""), svCMReasoning("R2", "")),
		svFrameIn(svRootLane, 4, oar.ToolCallStarted{CallID: "call", Tool: "Read"}),
		svFrameIn(svChildAgentLane, 5, oar.Retry{Attempt: 1}),
	)
	svEq(t, "parts", svPartsBySection(view), `[[["text(unnamed): A1","reasoning(unnamed): R1"],["text(unnamed): B1"],
		["text(unnamed): A2","reasoning(unnamed): R2"],["tool(call): Read"],["notice: retry"]]]`)
}

func TestSessionViewConcurrentIncrementalUpdatesPreserveEarlierViews(t *testing.T) {
	records := []oar.RawEvent{
		svCMRequest(0, oar.RequestPrompt),
		svFrameIn(svChildSession, 1, svCMText("A1", "a"), svCMReasoning("R1", "a")),
		svFrameIn(svRootLane, 2, svCMText("B1", "b")),
		svFrameIn(svChildSession, 3, svCMText("A2", "a"), svCMReasoning("R2", "a")),
		svFrameIn(svRootLane, 4, svCMText("B2", "b")),
	}
	view := observe.InitialSessionView()
	for index, record := range records {
		previous, _ := json.Marshal(view)
		next := observe.ReduceSessionView(view, record, "")
		if after, _ := json.Marshal(view); string(after) != string(previous) {
			t.Fatalf("record %d changed the previous view", index)
		}
		svSame(t, fmt.Sprintf("record %d vs replay", index), next, observe.ViewOf(records[:index+1], ""))
		svSame(t, fmt.Sprintf("record %d repeated", index), observe.ReduceSessionView(next, record, "").Messages, next.Messages)
		view = next
	}
	if sections := len(svTurns(view)[0].Sections); sections != 2 {
		t.Errorf("sections = %d", sections)
	}
}

func TestSessionViewConcurrentFlatEventsJoinNamedMessagesWithinATurn(t *testing.T) {
	events := []oar.Event{
		{Envelope: svRootLane.env(0), Body: oar.TextDelta{Text: "A1", MessageID: "a"}},
		{Envelope: svChildAgentLane.env(1), Body: oar.TextDelta{Text: "B1", MessageID: "b"}},
		{Envelope: svRootLane.env(2), Body: oar.TextDelta{Text: "A2", MessageID: "a"}},
		{Envelope: svRootLane.env(3), Body: oar.TurnEnded{Outcome: oar.Completed()}},
		{Envelope: svRootLane.env(4), Body: oar.TextDelta{Text: "new turn", MessageID: "a"}},
	}
	view := observe.InitialSessionView()
	for _, event := range events {
		view = observe.ReduceSessionViewEvent(view, event, "")
	}
	svEq(t, "parts", svPartsBySection(view), `[[["text(a): A1A2"],["text(b): B1"]],[["text(a): new turn"]]]`)
}
