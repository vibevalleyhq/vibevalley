package agent

import (
	"context"
	"reflect"
	"slices"
	"testing"

	"vibevalley/pkg/agentcore"
	"vibevalley/pkg/ai"
)

func TestCompactionPlanReplaysItsEntireRetainedTail(t *testing.T) {
	messages := []agentcore.AgentMessage{UserMessage("old"), ai.FauxAssistantMessage("old answer"), UserMessage("keep"), ai.FauxAssistantMessage("a"), ai.FauxAssistantMessage("b"), ai.FauxAssistantMessage("c")}
	options := CompactionOptions{Budget: 1, KeepRecent: 2}
	initial := planCompaction(messages, options)
	if initial == nil {
		t.Fatal("no plan")
	}
	cached := CompactionSummaryMessage{Summary: "summary", Kept: len(messages) - initial.cut}
	messages = append(messages, ai.FauxAssistantMessage("late tail"))
	plan := planCompaction(messages, options)
	if plan.cut != initial.cut {
		t.Fatal("test must reuse same archive prefix")
	}
	result := plan.apply(cached)
	session := SessionAt(t.TempDir() + "/session.jsonl")
	for _, message := range messages {
		if err := session.Append(message); err != nil {
			t.Fatal(err)
		}
	}
	if err := session.Append(result.summary); err != nil {
		t.Fatal(err)
	}
	if got := session.Load(); !reflect.DeepEqual(got, result.messages) {
		t.Fatalf("replay mismatch: got=%+v want=%+v", got, result.messages)
	}
	if result.summary.Kept != 5 || len(result.messages) != 6 {
		t.Fatalf("tail lost: %+v", result)
	}
}

func TestToolPolicyAppliesAfterAllToolsAreAssembled(t *testing.T) {
	blocked := []string{"custom", "load_skill", "spawn_agent", "schedule", "list_schedules", "cancel_schedule"}
	a := NewAgent(context.Background(), AgentOptions{Name: "test", Home: t.TempDir(), NoSession: true, Schedules: new(true), Tools: []agentcore.AgentTool{{Name: "custom"}}, DisallowedTools: blocked})
	defer a.Close()
	names := []string{}
	for _, tool := range a.Core.State().Tools {
		names = append(names, tool.Name)
		if slices.Contains(blocked, tool.Name) {
			t.Fatalf("blocked tool exposed: %s", tool.Name)
		}
	}
	if !slices.Contains(names, "remember") || !slices.Contains(names, "search_archive") {
		t.Fatalf("unrelated tools removed: %v", names)
	}
}
