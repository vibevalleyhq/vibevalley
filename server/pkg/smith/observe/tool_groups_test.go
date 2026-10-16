package observe

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"vibevalley/pkg/smith/oar"
)

// Ported from tests/tool-groups.test.ts and tests/tool-groups-cache.test.ts.

func tgText(value string) ViewPart { return ViewPart{Kind: "text", Text: value} }

var tgThought = ViewPart{Kind: "reasoning", Content: oar.ReasoningContent{Kind: "redacted"}}

func tgCall(id, tool string, input any, result string) ViewPart {
	text, ok := input.(string)
	if !ok {
		encoded, _ := json.Marshal(input)
		text = string(encoded)
	}
	if result == "" {
		result = "ok"
	}
	return ViewPart{Kind: "tool", CallID: id, Tool: tool, Input: &text, Result: result}
}

func TestGroupToolActivityGroupsWorkBetweenWords(t *testing.T) {
	parts := []ViewPart{
		tgText("Let me look."),
		tgThought,
		tgCall("1", "commandExecution", "/bin/bash -lc 'ls'", ""),
		tgCall("2", "webSearch", map[string]any{"query": "kimi"}, ""),
		tgCall("3", "commandExecution", "/bin/bash -lc 'npm test'", "failed"),
		tgText("One test fails."),
		tgCall("4", "commandExecution", "/bin/bash -lc 'git diff'", "running"),
	}
	segments := GroupToolActivity("codex", parts)
	var shape [][2]any
	for _, s := range segments {
		shape = append(shape, [2]any{s.Kind, s.Index})
	}
	if !reflect.DeepEqual(shape, [][2]any{{"part", 0}, {"tools", 1}, {"part", 5}, {"tools", 6}}) {
		t.Fatalf("segments %v", shape)
	}
	first, last := segments[1], segments[3]
	if len(first.Parts) != 4 {
		t.Fatalf("first parts %d", len(first.Parts))
	}
	if !reflect.DeepEqual(first.Counts, []ToolCount{{ToolRunCommand, 2}, {ToolWeb, 1}}) {
		t.Fatalf("counts %v", first.Counts)
	}
	if first.Failed != 1 || first.Running != nil {
		t.Fatalf("first %+v", first)
	}
	if last.Running == nil || last.Running.CallID != "4" {
		t.Fatalf("last running %+v", last.Running)
	}
}

func TestToolGroupSummaryWording(t *testing.T) {
	for _, c := range []struct {
		counts []ToolCount
		want   string
	}{
		{[]ToolCount{{ToolRunCommand, 3}, {ToolReadFile, 1}}, "Ran 3 commands, read a file"},
		{[]ToolCount{{ToolWeb, 1}}, "Searched the web"},
		{[]ToolCount{{ToolMCP, 1}, {ToolEditFile, 2}, {ToolOther, 1}}, "Used 2 tools, edited 2 files"},
		{nil, "Thought"},
	} {
		if got := ToolGroupSummary(c.counts, "done"); got != c.want {
			t.Fatalf("%v: %q, want %q", c.counts, got, c.want)
		}
	}
}

func TestReasoningOnlyGroupSummary(t *testing.T) {
	segments := GroupToolActivity("claude", []ViewPart{tgThought})
	if len(segments) != 1 || segments[0].Kind != "tools" {
		t.Fatalf("segments %+v", segments)
	}
	if got := ToolGroupSummary(segments[0].Counts, "running"); got != "Thinking…" {
		t.Fatal(got)
	}
	if got := ToolGroupSummary(segments[0].Counts, "done"); got != "Thought" {
		t.Fatal(got)
	}
	if got := ToolGroupSummary([]ToolCount{{ToolRunCommand, 1}}, "running"); got != "Ran a command" {
		t.Fatal(got)
	}
}

func TestToolGroupSummarySingularPlural(t *testing.T) {
	for _, c := range []struct {
		kind             ToolActionKind
		singular, plural string
	}{
		{ToolRunCommand, "Ran a command", "Ran 2 commands"},
		{ToolReadFile, "Read a file", "Read 2 files"},
		{ToolEditFile, "Edited a file", "Edited 2 files"},
		{ToolSearch, "Searched", "Searched 2 times"},
		{ToolWeb, "Searched the web", "Searched the web 2 times"},
		{ToolFetch, "Fetched a page", "Fetched 2 pages"},
		{ToolSubagent, "Ran a subagent", "Ran 2 subagents"},
		{ToolMCP, "Used a tool", "Used 2 tools"},
		{ToolWait, "Waited", "Waited 2 times"},
		{ToolOther, "Used a tool", "Used 2 tools"},
	} {
		if got := ToolGroupSummary([]ToolCount{{c.kind, 1}}, ""); got != c.singular {
			t.Fatalf("%s 1: %q", c.kind, got)
		}
		if got := ToolGroupSummary([]ToolCount{{c.kind, 2}}, ""); got != c.plural {
			t.Fatalf("%s 2: %q", c.kind, got)
		}
	}
}

func TestGroupToolActivityCountsSleepAsWait(t *testing.T) {
	segments := GroupToolActivity("codex", []ViewPart{tgText("I'll wait."), tgCall("1", "sleep", map[string]any{"durationMs": 50000}, "ended"), tgText("Done waiting.")})
	group := segments[1]
	if group.Kind != "tools" || !reflect.DeepEqual(group.Counts, []ToolCount{{ToolWait, 1}}) {
		t.Fatalf("group %+v", group)
	}
	if got := ToolGroupSummary(group.Counts, ""); got != "Waited" {
		t.Fatal(got)
	}
}

func TestToolGroupSummaryWait(t *testing.T) {
	if got := ToolGroupSummary([]ToolCount{{ToolWait, 1}}, ""); got != "Waited" {
		t.Fatal(got)
	}
	if got := ToolGroupSummary([]ToolCount{{ToolRunCommand, 1}, {ToolWait, 2}}, ""); got != "Ran a command, waited 2 times" {
		t.Fatal(got)
	}
}

func TestClaudeRunReadsByClaudeToolNames(t *testing.T) {
	segments := GroupToolActivity("claude", []ViewPart{
		tgCall("1", "Read", map[string]any{"file_path": "a.ts"}, ""),
		tgCall("2", "Edit", map[string]any{"file_path": "a.ts"}, ""),
		tgCall("3", "Bash", map[string]any{"command": "npm test"}, ""),
	})
	if got := ToolGroupSummary(segments[0].Counts, ""); got != "Read a file, edited a file, ran a command" {
		t.Fatal(got)
	}
}

// #318: grouping classifies a call by runtime and tool name, never by parsing its input.
func TestGroupingNeverPassesInputToClassifyTool(t *testing.T) {
	var inputs []*string
	saved := classifyForGroup
	classifyForGroup = func(runtimeID, tool string, inputJSON *string) ToolAction {
		inputs = append(inputs, inputJSON)
		return ClassifyTool(runtimeID, tool, inputJSON)
	}
	t.Cleanup(func() { classifyForGroup = saved })
	huge, _ := json.Marshal(map[string]any{"file_path": "/w/a.ts", "content": strings.Repeat("x", 200_000)})
	parts := []ViewPart{
		tgCall("a", "Read", `{"file_path":"/w/a.ts"}`, "ok"),
		tgCall("b", "Write", string(huge), "running"),
	}
	segments := GroupToolActivity("claude", parts)
	if len(inputs) != 2 || inputs[0] != nil || inputs[1] != nil {
		t.Fatalf("classifyTool saw inputs %v", inputs)
	}
	if len(segments) != 1 || segments[0].Kind != "tools" || !reflect.DeepEqual(segments[0].Counts, []ToolCount{{ToolReadFile, 1}, {ToolEditFile, 1}}) {
		t.Fatalf("segments %+v", segments)
	}
}
