package main

import (
	"testing"

	"vibevalley/internal/protocol"
)

func TestOldNamesBecomeTodays(t *testing.T) {
	for old, want := range map[string]string{"foreman": "manager", "helper": "agent", "user": "user", "system": "system"} {
		if got := participantKind(old); got != want {
			t.Errorf("kind %q = %q, want %q", old, got, want)
		}
	}
	if got := participantID("foreman"); got != "manager" {
		t.Errorf("foreman id = %q", got)
	}
	for old, want := range map[string]string{"harvested": "merged", "merged": "merged", "dismissed": "dismissed", "lost": "lost"} {
		if got := closedReason(old); got != want {
			t.Errorf("closed %q = %q, want %q", old, got, want)
		}
	}
}

func TestRenamesKeysAnywhere(t *testing.T) {
	body := `{"helper":"w1","turns":2,"nested":{"helper":"w2"},"list":[{"turns":3}],"text":"helper"}`
	got := renameJSONKeys(body, map[string]string{"helper": "session", "turns": "runs"})
	want := `{"list":[{"runs":3}],"nested":{"session":"w2"},"runs":2,"session":"w1","text":"helper"}`
	if got != want {
		t.Errorf("got %s, want %s", got, want)
	}
	if got := renameJSONKeys("{not json", map[string]string{"helper": "session"}); got != "{not json" {
		t.Errorf("invalid JSON changed: %s", got)
	}
}

func TestStepsBecomeRunEvents(t *testing.T) {
	ended := int64(500)
	ok := true
	head := oldHead{ID: "w1", StartedAt: 100, EndedAt: &ended, Outcome: "completed"}
	steps := []oldStep{
		{At: 110, Kind: "asked", Text: "do it"},
		{At: 120, Kind: "tool", Text: "ls", Action: "run_command", Tool: "Bash", Input: `{"command":"ls"}`, Output: "a.go", Ok: &ok},
		{At: 130, Kind: "said", Text: "done"},
	}
	events := convertSteps(head, steps)
	if len(events) != 6 {
		t.Fatalf("%d events: %+v", len(events), events)
	}
	if events[0].Type != protocol.SessionEventTypeRunStart || events[0].Time != 100 || events[0].Run == nil || *events[0].Run != 1 {
		t.Fatalf("first %+v", events[0])
	}
	if events[1].Type != protocol.SessionEventTypeUserMessage || events[2].Type != protocol.SessionEventTypeToolCall {
		t.Fatalf("order %+v", events)
	}
	call, result := events[2], events[3]
	if result.Type != protocol.SessionEventTypeToolResult || result.Call == nil || *result.Call != call.Seq {
		t.Fatalf("result does not point at its call: %+v %+v", call, result)
	}
	if call.Action == nil || *call.Action != protocol.ToolActionRunCommand || call.Input == nil || *call.Input != `{"command":"ls"}` {
		t.Fatalf("call %+v", call)
	}
	if result.Ok == nil || !*result.Ok || result.Output == nil || *result.Output != "a.go" {
		t.Fatalf("result %+v", result)
	}
	last := events[len(events)-1]
	if last.Type != protocol.SessionEventTypeRunEnd || last.Time != 500 || last.Text != "completed" {
		t.Fatalf("last %+v", last)
	}
	for i, e := range events {
		if e.Seq != int64(i+1) {
			t.Fatalf("seq %d: %+v", i, e)
		}
	}
}

func TestUnknownToolActionIsOther(t *testing.T) {
	if got := toolAction("open_file"); got != protocol.ToolActionOther {
		t.Fatalf("got %q", got)
	}
	if got := toolAction("web"); got != protocol.ToolActionWeb {
		t.Fatalf("got %q", got)
	}
}
