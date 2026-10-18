package brain

import (
	"reflect"
	"testing"

	"vibevalley/pkg/agentcore"
)

func TestAgentExtensionsHaveTheirOwnPayload(t *testing.T) {
	summary := &CompactionSummaryMessage{Summary: "kept", Kept: 2}
	cases := []struct {
		event AgentEvent
		kind  agentcore.EventKind
	}{
		{AgentSettled{Run: RunResult{Aborted: true}}, EventAgentSettled},
		{CompactionStarted{Reason: "threshold"}, EventCompactionStart},
		{CompactionEnded{Reason: "threshold"}, EventCompactionEnd},
		{CompactionEnded{Reason: "threshold", Compaction: summary}, EventCompactionEnd},
		{TasksChanged{}, EventTasksChanged},
	}
	for _, tc := range cases {
		if tc.event.Kind() != tc.kind {
			t.Fatalf("kind: %s", tc.event.Kind())
		}
		typ := reflect.TypeOf(tc.event)
		if _, exists := typ.FieldByName("Type"); exists {
			t.Fatal("extension has mutable tag")
		}
		if _, exists := typ.FieldByName("AgentEvent"); exists {
			t.Fatal("extension still embeds the nullable core payload matrix")
		}
		if event, ok := tc.event.(CompactionEnded); ok && event.Compaction != nil && event.Compaction != summary {
			t.Fatal("summary was changed")
		}
	}
}
