package oarruntime

import (
	"testing"

	"vibevalley/internal/agent/brain"
	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

func TestTypedPayloadsMapToRuntimeEvents(t *testing.T) {
	cases := []struct {
		input brain.AgentEvent
		kind  string
		check func(*testing.T, oar.EventBody)
	}{
		{agentcore.MessageUpdated{Delta: ai.AssistantMessageEvent{Type: ai.EventTextDelta, Delta: "words"}}, "text_delta", nil},
		{agentcore.MessageUpdated{Delta: ai.AssistantMessageEvent{Type: ai.EventThinkingEnd, Content: "thought"}}, "reasoning", nil},
		{agentcore.ToolStarted{ToolCallID: "c", ToolName: "read"}, "tool_call_started", nil},
		{agentcore.ToolEnded{ToolCallID: "c", Result: agentcore.TextResult("stopped"), IsError: true}, "tool_call_ended", func(t *testing.T, b oar.EventBody) {
			if b.(oar.ToolCallEnded).Result != "failed" {
				t.Fatal(b)
			}
		}},
		{brain.CompactionStarted{Reason: "threshold"}, "compaction_started", nil},
		{brain.CompactionEnded{Reason: "threshold"}, "compaction_ended", func(t *testing.T, b oar.EventBody) {
			if b.(oar.CompactionEnded).Outcome != "failed" {
				t.Fatal(b)
			}
		}},
		{brain.CompactionEnded{Reason: "threshold", Compaction: &brain.CompactionSummaryMessage{Summary: "kept"}}, "compaction_ended", func(t *testing.T, b oar.EventBody) {
			if b.(oar.CompactionEnded).Outcome != "completed" {
				t.Fatal(b)
			}
		}},
	}
	for _, tc := range cases {
		t.Run(string(tc.input.Kind())+tc.kind, func(t *testing.T) {
			s := &session{kernel: kernel.New("typed")}
			s.said(tc.input)
			var events []oar.Event
			read := observe.EventsReader(func(e oar.Event) { events = append(events, e) })
			for _, record := range s.kernel.Records() {
				read(record)
			}
			if len(events) != 1 || events[0].Kind() != tc.kind {
				t.Fatalf("mapped events: %+v", events)
			}
			if tc.check != nil {
				tc.check(t, events[0].Body)
			}
		})
	}
}
