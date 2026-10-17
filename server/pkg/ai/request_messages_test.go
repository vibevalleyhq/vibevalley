package ai

import (
	"reflect"
	"testing"
)

func TestRequestTranscriptPairsToolsWithoutChangingHistory(t *testing.T) {
	answer := FauxAssistantMessage([]Content{NewText("answer"), FauxToolCall("read", "{}", "kept"), FauxToolCall("read", "{}", "unanswered")})
	messages := []Message{ToolResultMessage{ToolCallID: "before"}, answer, ToolResultMessage{ToolCallID: "kept"}, ToolResultMessage{ToolCallID: "orphan"}}
	before := Stringify(messages)
	normalized := requestMessages(messages)
	if len(normalized) != 2 {
		t.Fatalf("unpaired messages remain: %+v", normalized)
	}
	calls := normalized[0].(AssistantMessage).ToolCalls()
	if len(calls) != 1 || calls[0].ID != "kept" {
		t.Fatalf("wrong calls: %+v", calls)
	}
	if Stringify(messages) != before {
		t.Fatal("normalization changed persisted history")
	}
	if !reflect.DeepEqual(normalized, requestMessages(normalized)) {
		t.Fatal("normalization is not idempotent")
	}
	if got := ToChatMessages(flash(), Context{Messages: messages}); len(got) != 2 || len(got[0].ToolCalls) != 1 {
		t.Fatal(got)
	}
	if _, got := ToAnthropicMessages(claude(), Context{Messages: messages}); len(got) != 2 {
		t.Fatal(got)
	}
}
