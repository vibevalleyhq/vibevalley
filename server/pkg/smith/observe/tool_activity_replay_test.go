package observe

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"unicode/utf16"
)

// Ported from tests/replay/tool-activity.test.ts: the tool calls of the REAL
// recorded fixtures run through ClassifyTool + ToolActionLabel and match the
// *.activity.txt snapshots. The claude, codex and pi extraction is plain JSON
// reading, ported here; the ACP snapshots need the ACP projection and the
// session view (not ported here), so their classifications are pinned on the
// inputs the TS inline snapshots record.

const replayFixtures = "../testdata/replay/fixtures"

type replayCall struct {
	runtime, tool string
	input         *string
}

func replayLines(t *testing.T, name string) []string {
	t.Helper()
	text, err := os.ReadFile(filepath.Join(replayFixtures, name))
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, line := range strings.Split(string(text), "\n") {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func replayJSON(value any) *string {
	encoded, _ := json.Marshal(value)
	text := string(encoded)
	return &text
}

func callsFromClaude(lines []string) []replayCall {
	var calls []replayCall
	for _, line := range lines {
		message := asRecord(parseJSON(line))
		if message["type"] != "assistant" {
			continue
		}
		content, _ := asRecord(message["message"])["content"].([]any)
		for _, raw := range content {
			block := asRecord(raw)
			if block["type"] == "tool_use" {
				calls = append(calls, replayCall{runtime: "claude", tool: fmt.Sprint(block["name"]), input: replayJSON(block["input"])})
			}
		}
	}
	return calls
}

// codexItemInput is codex/item-detail.ts codexItemInput: the input as the projection hands it on.
func codexItemInput(item map[string]any) *string {
	switch item["type"] {
	case "commandExecution":
		if command, ok := item["command"].(string); ok {
			return &command
		}
	case "fileChange":
		if changes, ok := item["changes"].([]any); ok {
			return replayJSON(changes)
		}
	case "mcpToolCall":
		if arguments, ok := item["arguments"]; ok {
			return replayJSON(arguments)
		}
	case "webSearch":
		if query, ok := item["query"].(string); ok {
			return &query
		}
	case "sleep":
		if duration, ok := item["durationMs"].(float64); ok {
			return replayJSON(map[string]any{"durationMs": duration})
		}
	}
	return nil
}

// Only items that become tool_call events (see codex projection TOOL_ITEM_TYPES).
var codexToolTypes = map[string]bool{"commandExecution": true, "fileChange": true, "mcpToolCall": true, "webSearch": true, "sleep": true}

func callsFromCodex(lines []string) []replayCall {
	var calls []replayCall
	for _, line := range lines {
		frame := asRecord(parseJSON(line))
		if frame["method"] != "item/started" {
			continue
		}
		item := asRecord(frame["item"])
		if itemType, ok := item["type"].(string); ok && codexToolTypes[itemType] {
			calls = append(calls, replayCall{runtime: "codex", tool: itemType, input: codexItemInput(item)})
		}
	}
	return calls
}

func callsFromPi(lines []string) []replayCall {
	var calls []replayCall
	for _, line := range lines {
		event := asRecord(parseJSON(line))
		if event["type"] == "tool_execution_start" {
			calls = append(calls, replayCall{runtime: "pi", tool: fmt.Sprint(event["toolName"]), input: replayJSON(event["args"])})
		}
	}
	return calls
}

// utf16Slice is String.prototype.slice(0, n).
func utf16Slice(text string, n int) string {
	units := utf16.Encode([]rune(text))
	if len(units) <= n {
		return text
	}
	return string(utf16.Decode(units[:n]))
}

// padEnd is String.prototype.padEnd(n) in UTF-16 units.
func padEnd(text string, n int) string {
	if length := len(utf16.Encode([]rune(text))); length < n {
		return text + strings.Repeat(" ", n-length)
	}
	return text
}

func renderCalls(calls []replayCall) string {
	var rows []string
	for _, call := range calls {
		action := ClassifyTool(call.runtime, call.tool, call.input)
		row := padEnd(call.tool, 20) + " │ " + ToolActionLabel(action.Kind, "running")
		if action.Detail != "" {
			row += ": " + utf16Slice(action.Detail, 40)
		}
		rows = append(rows, row)
	}
	return strings.Join(rows, "\n") + "\n"
}

func assertSnapshot(t *testing.T, got, name string) {
	t.Helper()
	want, err := os.ReadFile(filepath.Join(replayFixtures, name))
	if err != nil {
		t.Fatal(err)
	}
	if got != string(want) {
		t.Fatalf("%s:\ngot:\n%s\nwant:\n%s", name, got, want)
	}
}

func TestReplayActivitySnapshots(t *testing.T) {
	for _, scenario := range []string{"tool-round", "mcp-echo"} {
		assertSnapshot(t, renderCalls(callsFromClaude(replayLines(t, "claude-"+scenario+".raw.jsonl"))), "claude-"+scenario+".activity.txt")
		assertSnapshot(t, renderCalls(callsFromPi(replayLines(t, "pi-"+scenario+".raw.jsonl"))), "pi-"+scenario+".activity.txt")
	}
	for _, scenario := range []string{"tool-round", "file-change", "mcp-echo"} {
		assertSnapshot(t, renderCalls(callsFromCodex(replayLines(t, "codex-"+scenario+".raw.jsonl"))), "codex-"+scenario+".activity.txt")
	}
}

func TestReplayCodexFileChangeNamesEveryPath(t *testing.T) {
	calls := callsFromCodex(replayLines(t, "codex-file-change.raw.jsonl"))
	if len(calls) != 1 {
		t.Fatalf("calls %d", len(calls))
	}
	got := ClassifyTool(calls[0].runtime, calls[0].tool, calls[0].input)
	want := ToolAction{Kind: ToolEditFile, Detail: "<cwd>/added.txt", Paths: []string{"<cwd>/added.txt", "<cwd>/gone.txt", "<cwd>/notes.txt", "<cwd>/old-name.txt", "<cwd>/new-name.txt"}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %+v", got)
	}
}

func TestReplayShellCallsCarryCommand(t *testing.T) {
	var claude replayCall
	for _, call := range callsFromClaude(replayLines(t, "claude-tool-round.raw.jsonl")) {
		if call.tool == "Bash" {
			claude = call
			break
		}
	}
	codex := callsFromCodex(replayLines(t, "codex-tool-round.raw.jsonl"))[0]
	pi := callsFromPi(replayLines(t, "pi-tool-round.raw.jsonl"))[0]
	for _, c := range []struct {
		call                 replayCall
		command, description string
	}{
		{claude, "echo oar-replay-marker", "Echo the marker string"},
		{codex, "/bin/bash -lc 'echo oar-codex-marker'", ""},
		{pi, "echo oar-round-one", ""},
	} {
		action := ClassifyTool(c.call.runtime, c.call.tool, c.call.input)
		if action.Command != c.command || action.Description != c.description {
			t.Fatalf("%s: %+v", c.call.runtime, action)
		}
	}
}

// The ACP inline snapshots of tests/replay/tool-activity.test.ts, on their recorded inputs.
func TestReplayACPCallsClassify(t *testing.T) {
	for _, c := range []struct {
		runtime, tool string
		input         *string
		want          ToolAction
	}{
		{"grok", "run_terminal_command", taStr(`{"command":"<command>","description":"<description>","is_background":"<is_background>","variant":"<variant>"}`),
			ToolAction{Kind: ToolRunCommand, Detail: "<command>", Command: "<command>", Description: "<description>"}},
		{"kimi", "Bash", taStr(`{"command":"<command>"}`), ToolAction{Kind: ToolRunCommand, Detail: "<command>", Command: "<command>"}},
		// An opencode bash call opens with only its cwd; its command arrives as the call's input.
		{"opencode", "bash", taStr(`{"cwd":"<cwd>"}`), ToolAction{Kind: ToolRunCommand}},
		{"opencode", "bash", taStr(`{"command":"<command>","cwd":"<cwd>"}`), ToolAction{Kind: ToolRunCommand, Detail: "<command>", Command: "<command>"}},
		{"opencode", "write", taStr(`{"content":"<content>","filePath":"<filePath>"}`), ToolAction{Kind: ToolEditFile, Detail: "<filePath>", Paths: []string{"<filePath>"}}},
		{"opencode", "read", taStr(`{"filePath":"<filePath>"}`), ToolAction{Kind: ToolReadFile, Detail: "<filePath>", Paths: []string{"<filePath>"}}},
		{"opencode", "edit", taStr(`{"filePath":"<filePath>","newString":"<newString>","oldString":"<oldString>"}`), ToolAction{Kind: ToolEditFile, Detail: "<filePath>", Paths: []string{"<filePath>"}}},
		{"opencode", "grep", taStr(`{"path":"<path>","pattern":"<pattern>"}`), ToolAction{Kind: ToolSearch, Detail: "<path>"}},
		{"opencode", "glob", taStr(`{"path":"<path>","pattern":"<pattern>"}`), ToolAction{Kind: ToolSearch, Detail: "<path>"}},
		{"opencode", "bash", taStr(`{"command":"<command>","workdir":"<workdir>"}`), ToolAction{Kind: ToolRunCommand, Detail: "<command>", Command: "<command>"}},
	} {
		taAssert(t, ClassifyTool(c.runtime, c.tool, c.input), c.want)
	}
}
