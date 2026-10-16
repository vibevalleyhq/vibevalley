package claude

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
)

// Ports tests/replay/claude-projection.test.ts and
// tests/replay/claude-interrupt-lifecycle.test.ts: recorded claude stdout
// folded through the pure projection.

const replayFixtures = "../../testdata/replay/fixtures"

var replayScenarios = []string{"tool-round", "multi-turn", "steer", "error", "background-tasks", "mcp-echo", "usage-subagent-compact", "workflow", "workflow-agent-tool", "workflow-stopped"}

func describeTokens(tokens oar.TokenTotals) string {
	text := fmt.Sprintf("in=%d out=%d", tokens.Input, tokens.Output)
	if tokens.CacheRead != nil {
		text += fmt.Sprintf(" cacheRead=%d", *tokens.CacheRead)
	}
	if tokens.CacheWrite != nil {
		text += fmt.Sprintf(" cacheWrite=%d", *tokens.CacheWrite)
	}
	return text
}

func describeCommand(command projectionCommand) string {
	switch command.Kind {
	case "respond":
		return "respond " + command.RequestID + " " + string(command.Response.Kind)
	case "toApp":
		return "toApp " + command.Type
	case "frame":
		at := ""
		if len(command.AgentPath) > 0 {
			at = " @" + strings.Join(command.AgentPath, "/")
		}
		var events []string
		for _, view := range command.Body.Events {
			switch typed := view.(type) {
			case oar.ToolCallStarted:
				events = append(events, "tool_call_started "+typed.Tool)
			case oar.Reasoning:
				events = append(events, "reasoning "+typed.Content.Kind)
			case oar.TurnEnded:
				events = append(events, "turn_ended "+typed.Outcome.Kind)
			case oar.Usage:
				parts := []string{"usage"}
				if typed.Usage.Tokens != nil {
					parts = append(parts, describeTokens(*typed.Usage.Tokens))
				}
				if typed.Usage.Total != nil {
					parts = append(parts, "total "+describeTokens(*typed.Usage.Total))
				}
				events = append(events, strings.Join(parts, " "))
			default:
				events = append(events, view.EventKind())
			}
		}
		if len(events) == 0 {
			return "event" + at
		}
		return "event" + at + " → " + strings.Join(events, ", ")
	}
	return "?"
}

func summarizeFrame(message jsonx.Record) string {
	blocks := ""
	switch content := jsonx.AsRecord(message["message"])["content"].(type) {
	case string:
		blocks = "text"
	case []any:
		var kinds []string
		for _, block := range content {
			kind, _ := jsonx.AsRecord(block)["type"].(string)
			kinds = append(kinds, kind)
		}
		blocks = strings.Join(kinds, ",")
	}
	var parts []string
	for _, part := range []any{message["type"], message["subtype"], blocks} {
		if text, ok := part.(string); ok && text != "" {
			parts = append(parts, text)
		}
	}
	return strings.Join(parts, " ")
}

// padEnd is String.prototype.padEnd in UTF-16 units.
func padEnd(text string, width int) string {
	units := 0
	for _, r := range text {
		if r > 0xFFFF {
			units += 2
		} else {
			units++
		}
	}
	if units >= width {
		return text
	}
	return text + strings.Repeat(" ", width-units)
}

func readLines(t *testing.T, file string) []string {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var lines []string
	for _, line := range strings.Split(string(data), "\n") {
		if strings.TrimSpace(line) != "" {
			lines = append(lines, line)
		}
	}
	return lines
}

func foldFixture(lines []string) string {
	// Seed as if a prompt opened the first turn.
	state := claudePrompted(initialClaudeProjection(), "", true)
	var rows []string
	for _, line := range lines {
		message, ok := parseNative([]byte(line))
		if !ok {
			continue
		}
		var commands []projectionCommand
		state, commands = foldClaudeStdout(state, message)
		var produced []string
		for _, command := range commands {
			produced = append(produced, describeCommand(command))
		}
		joined := strings.Join(produced, ", ")
		if joined == "" {
			joined = "-"
		}
		rows = append(rows, padEnd(summarizeFrame(message.Record), 28)+" │ "+joined)
	}
	return strings.Join(rows, "\n") + "\n"
}

func TestRecordedStdoutFoldsToTheExpectedRecords(t *testing.T) {
	for _, scenario := range replayScenarios {
		t.Run(scenario, func(t *testing.T) {
			lines := readLines(t, filepath.Join(replayFixtures, "claude-"+scenario+".raw.jsonl"))
			want, err := os.ReadFile(filepath.Join(replayFixtures, "claude-"+scenario+".projected.txt"))
			if err != nil {
				t.Fatal(err)
			}
			if got := foldFixture(lines); got != string(want) {
				t.Errorf("projection differs\n--- got\n%s\n--- want\n%s", got, want)
			}
		})
	}
}

func fold(state projectionState, frame map[string]any) (projectionState, []projectionCommand) {
	return foldClaudeStdout(state, nativeOf(jsonx.ParseRecord([]byte(jsonText(frame)))))
}

func TestSubAgentFramesAttributeToTheTaskCallThatSpawnedThem(t *testing.T) {
	frames := []map[string]any{
		{"type": "assistant", "message": map[string]any{"content": []any{map[string]any{"type": "tool_use", "id": "task-1", "name": "Task", "input": map[string]any{}}}}},
		{"type": "assistant", "parent_tool_use_id": "task-1", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "child"}, map[string]any{"type": "tool_use", "id": "task-2", "name": "Task", "input": map[string]any{}}}}},
		{"type": "assistant", "parent_tool_use_id": "task-2", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "grandchild"}}}},
		{"type": "user", "parent_tool_use_id": "task-1", "message": map[string]any{"content": []any{map[string]any{"type": "tool_result", "tool_use_id": "task-2", "content": "done"}}}},
		{"type": "assistant", "message": map[string]any{"content": []any{map[string]any{"type": "text", "text": "root again"}}}},
	}
	state := claudePrompted(initialClaudeProjection(), "", true)
	var paths []string
	for _, frame := range frames {
		var commands []projectionCommand
		state, commands = fold(state, frame)
		for _, command := range commands {
			if command.Kind == "frame" {
				path := strings.Join(command.AgentPath, "/")
				if path == "" {
					path = "root"
				}
				paths = append(paths, path)
			}
		}
	}
	want := []string{"root", "task-1", "task-1/task-2", "task-1", "root"}
	if !reflect.DeepEqual(paths, want) {
		t.Fatalf("paths = %v, want %v", paths, want)
	}
}

func resultFrame(agent string, input, output int) map[string]any {
	frame := map[string]any{"type": "result", "subtype": "success", "is_error": false,
		"usage": map[string]any{"input_tokens": input, "output_tokens": output, "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}}
	if agent != "" {
		frame["parent_tool_use_id"] = agent
	}
	return frame
}

func usageTotals(frames []map[string]any) []string {
	state := claudePrompted(initialClaudeProjection(), "", true)
	var totals []string
	for _, frame := range frames {
		var commands []projectionCommand
		state, commands = fold(state, frame)
		for _, command := range commands {
			if command.Kind != "frame" {
				continue
			}
			var tokens *oar.TokenTotals
			for _, view := range command.Body.Events {
				if usage, ok := view.(oar.Usage); ok {
					tokens = usage.Usage.Tokens
					break
				}
			}
			path := strings.Join(command.AgentPath, "/")
			if path == "" {
				path = "root"
			}
			totals = append(totals, path+":"+jsonText(tokens))
		}
	}
	return totals
}

func TestResultUsageAccumulatesPerAgentIntoCumulativeTotals(t *testing.T) {
	got := usageTotals([]map[string]any{resultFrame("", 10, 1), resultFrame("", 20, 2), resultFrame("task-9", 5, 5)})
	want := []string{
		`root:{"input":10,"output":1,"cacheRead":0,"cacheWrite":0}`,
		`root:{"input":30,"output":3,"cacheRead":0,"cacheWrite":0}`,
		`task-9:{"input":5,"output":5,"cacheRead":0,"cacheWrite":0}`,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
}

func recordedResult(t *testing.T) map[string]any {
	t.Helper()
	for _, line := range readLines(t, filepath.Join(replayFixtures, "claude-background-tasks.raw.jsonl")) {
		frame := jsonx.ParseRecord([]byte(line))
		if frame["type"] == "result" {
			assertJSON(t, frame["usage"], `{"input_tokens":4,"output_tokens":359,"cache_read_input_tokens":29198,"cache_creation_input_tokens":9807}`)
			return frame
		}
	}
	t.Fatal("no result frame")
	return nil
}

// #161: cache reads and writes are parts of input, each accumulated like input.
func TestCacheReadsAndWritesAccumulatePerAgentAsPartsOfInput(t *testing.T) {
	recorded := recordedResult(t)
	bare := map[string]any{"type": "result", "subtype": "success", "usage": map[string]any{"input_tokens": 7, "output_tokens": 3}}
	child := map[string]any{"type": "result", "subtype": "success", "usage": map[string]any{"input_tokens": 7, "output_tokens": 3}, "parent_tool_use_id": "task-9"}
	got := usageTotals([]map[string]any{recorded, recorded, bare, child})
	want := []string{
		`root:{"input":39009,"output":359,"cacheRead":29198,"cacheWrite":9807}`,
		`root:{"input":78018,"output":718,"cacheRead":58396,"cacheWrite":19614}`,
		`root:{"input":78025,"output":721,"cacheRead":58396,"cacheWrite":19614}`,
		`task-9:{"input":7,"output":3}`,
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v\nwant %v", got, want)
	}
}

// assertJSON compares a value's JSON with the expected JSON semantically.
func assertJSON(t *testing.T, got any, want string) {
	t.Helper()
	encoded, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	var left, right any
	if err := json.Unmarshal(encoded, &left); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal([]byte(want), &right); err != nil {
		t.Fatalf("bad expectation %s: %v", want, err)
	}
	if !reflect.DeepEqual(left, right) {
		t.Fatalf("got  %s\nwant %s", encoded, want)
	}
}

func frameEvents(commands []projectionCommand) []oar.EventBody {
	if len(commands) == 0 || commands[0].Kind != "frame" {
		return nil
	}
	return nonNilEvents(commands[0].Body.Events)
}

func nonNilEvents(events []oar.EventBody) []oar.EventBody {
	if events == nil {
		return []oar.EventBody{}
	}
	return events
}

func TestToolResultIsFailedOnIsErrorTrueAndOkOtherwise(t *testing.T) {
	state, commands := fold(claudePrompted(initialClaudeProjection(), "", true), map[string]any{
		"type": "user", "message": map[string]any{"content": []any{map[string]any{"type": "tool_result", "tool_use_id": "c-fail", "is_error": true, "content": "nope"}}},
	})
	assertJSON(t, frameEvents(commands), `[{"kind":"tool_call_ended","callId":"c-fail","content":[{"type":"text","text":"nope"}],"result":"failed"}]`)
	_, commands = fold(state, map[string]any{
		"type": "user", "message": map[string]any{"content": []any{map[string]any{"type": "tool_result", "tool_use_id": "c-write", "content": "File created successfully at: /tmp/a.js"}}},
	})
	assertJSON(t, frameEvents(commands), `[{"kind":"tool_call_ended","callId":"c-write","content":[{"type":"text","text":"File created successfully at: /tmp/a.js"}],"result":"ok"}]`)
}

func endedEvents(content any) []oar.EventBody {
	_, commands := fold(claudePrompted(initialClaudeProjection(), "", true), map[string]any{
		"type": "user", "message": map[string]any{"content": []any{map[string]any{"type": "tool_result", "tool_use_id": "c", "content": content}}},
	})
	return frameEvents(commands)
}

// #73: a string is one text part, blocks are ordered parts, unknown blocks are kept whole.
func TestToolResultContentParts(t *testing.T) {
	png := map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/png", "data": "iVBORw0KGgo"}}
	assertJSON(t, endedEvents([]any{png}), `[{"kind":"tool_call_ended","callId":"c","content":[{"type":"image","mediaType":"image/png","data":"iVBORw0KGgo"}],"result":"ok"}]`)
	mcp := []any{map[string]any{"type": "text", "text": "before"}, map[string]any{"type": "image", "data": "R0lGOD", "mimeType": "image/gif"}, map[string]any{"type": "text", "text": "after"}}
	assertJSON(t, endedEvents(mcp), `[{"kind":"tool_call_ended","callId":"c","content":[{"type":"text","text":"before"},{"type":"image","mediaType":"image/gif","data":"R0lGOD"},{"type":"text","text":"after"}],"result":"ok"}]`)
	reference := map[string]any{"type": "tool_reference", "tool_name": "x"}
	assertJSON(t, endedEvents([]any{reference}), `[{"kind":"tool_call_ended","callId":"c","content":[{"type":"other","value":{"type":"tool_reference","tool_name":"x"}}],"result":"ok"}]`)
	assertJSON(t, endedEvents([]any{}), `[{"kind":"tool_call_ended","callId":"c","result":"ok"}]`)
}

func TestCompactBoundaryIsTheRuntimesAfterTheFactCompactionReport(t *testing.T) {
	_, commands := fold(claudePrompted(initialClaudeProjection(), "", true), map[string]any{
		"type": "system", "subtype": "compact_boundary", "compact_metadata": map[string]any{"trigger": "manual", "pre_tokens": 120000}, "session_id": "s", "uuid": "u",
	})
	if len(commands) != 1 {
		t.Fatalf("commands = %d", len(commands))
	}
	assertJSON(t, frameEvents(commands), `[{"kind":"compaction_ended","outcome":"completed","trigger":"manual"}]`)
}

func assistantEvents(message map[string]any) []oar.EventBody {
	_, commands := fold(claudePrompted(initialClaudeProjection(), "", true), map[string]any{"type": "assistant", "message": message})
	return frameEvents(commands)
}

func TestAssistantTextNamesItsAPIMessageID(t *testing.T) {
	assertJSON(t, assistantEvents(map[string]any{"id": "msg_01", "role": "assistant", "content": []any{map[string]any{"type": "text", "text": "first"}, map[string]any{"type": "tool_use", "id": "c1", "name": "Read", "input": map[string]any{}}}}),
		`[{"kind":"text_delta","text":"first","messageId":"msg_01"},{"kind":"tool_call_started","callId":"c1","tool":"Read","input":"{}"}]`)
	assertJSON(t, assistantEvents(map[string]any{"content": []any{map[string]any{"type": "text", "text": "no id"}}}), `[{"kind":"text_delta","text":"no id"}]`)
}

// claude 2.1.292 names a failed turn's cause on its synthetic assistant frame
// (error) and the result's api_error_status.
func TestFailedResultTakesTheClassOfTheTurnsErrorFrame(t *testing.T) {
	var outcomes []oar.TurnOutcome
	state := claudePrompted(initialClaudeProjection(), "", true)
	for _, frame := range []map[string]any{
		{"type": "assistant", "error": "authentication_failed", "message": map[string]any{"model": "<synthetic>", "content": []any{map[string]any{"type": "text", "text": "Invalid API key · Fix external API key"}}}},
		{"type": "result", "subtype": "success", "is_error": true, "api_error_status": 401, "terminal_reason": "api_error", "result": "Invalid API key · Fix external API key"},
		{"type": "result", "subtype": "success", "is_error": true, "api_error_status": 529, "terminal_reason": "api_error", "result": "API Error: 529 Overloaded."},
	} {
		var commands []projectionCommand
		state, commands = fold(state, frame)
		for _, command := range commands {
			for _, view := range command.Body.Events {
				if ended, ok := view.(oar.TurnEnded); ok && command.Kind == "frame" {
					outcomes = append(outcomes, ended.Outcome)
				}
			}
		}
	}
	assertJSON(t, outcomes, `[
		{"kind":"failed","reason":"Invalid API key · Fix external API key","failure":"auth","credential":"rejected","status":401},
		{"kind":"failed","reason":"API Error: 529 Overloaded.","failure":"overloaded","status":529}]`)
}

func readRecords(t *testing.T, file string) []jsonx.Record {
	t.Helper()
	var records []jsonx.Record
	for _, line := range readLines(t, file) {
		if record := jsonx.ParseRecord([]byte(line)); record != nil {
			records = append(records, record)
		}
	}
	return records
}

// Claude 2.1.292 + scripted provider: only cancellation before started returns the input.
func TestRecordedInterruptLifecycle(t *testing.T) {
	for _, tc := range []struct {
		name     string
		dropped  bool
		turnEnds int
	}{
		{"cancel-queued-collision", true, 2},
		{"cancel-queued-before-start", true, 0},
		{"cancel-queued-after-start", false, 1},
		{"plain-interrupt-after-start", false, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			rawLines := readLines(t, filepath.Join(replayFixtures, "claude-"+tc.name+".raw.jsonl"))
			writes := readRecords(t, filepath.Join(replayFixtures, "claude-"+tc.name+".stdin.jsonl"))
			state := initialClaudeProjection()
			var commands []projectionCommand
			var frames []jsonx.Record
			for _, line := range rawLines {
				message, ok := parseNative([]byte(line))
				if !ok {
					continue
				}
				frame := message.Record
				frames = append(frames, frame)
				if frame["type"] == "command_lifecycle" && frame["state"] == "queued" {
					inputID := jsString(frame["command_uuid"])
					found := false
					for _, write := range writes {
						if write["type"] == "user" && write["uuid"] == inputID {
							found = true
						}
					}
					if !found {
						t.Fatalf("queued %s was never written", inputID)
					}
					state = claudePrompted(state, inputID, true)
				}
				if (frame["type"] == "command_lifecycle" && frame["state"] == "cancelled") || frame["type"] == "control_response" {
					state = claudeAbortRequested(state)
				}
				var folded []projectionCommand
				state, folded = foldClaudeStdout(state, message)
				commands = append(commands, folded...)
			}
			var events []oar.EventBody
			var natives []any
			for _, command := range commands {
				switch command.Kind {
				case "frame":
					events = append(events, command.Body.Events...)
					natives = append(natives, jsonx.ParseRecord(command.Body.Native))
				case "respond":
					natives = append(natives, jsonx.ParseRecord(command.Response.Native))
				}
			}
			var want []any
			for _, frame := range frames {
				want = append(want, frame)
			}
			if !reflect.DeepEqual(natives, want) {
				t.Fatalf("natives differ from frames")
			}
			inputID := ""
			for _, write := range writes {
				if write["type"] == "user" {
					inputID, _ = write["uuid"].(string)
				}
			}
			var dropped []oar.EventBody
			var ends []oar.TurnEnded
			for _, event := range events {
				if _, ok := event.(oar.InputDropped); ok {
					dropped = append(dropped, event)
				}
				if ended, ok := event.(oar.TurnEnded); ok {
					ends = append(ends, ended)
				}
			}
			if tc.dropped {
				assertJSON(t, dropped, `[{"kind":"input_dropped","inputId":"`+inputID+`","reason":"turn_interrupted"}]`)
			} else if len(dropped) != 0 {
				t.Fatalf("dropped = %v", dropped)
			}
			if len(ends) != tc.turnEnds {
				t.Fatalf("turn ends = %d, want %d", len(ends), tc.turnEnds)
			}
			if tc.turnEnds > 0 && ends[len(ends)-1].Outcome.Kind != "aborted" {
				t.Fatalf("last outcome = %v", ends[len(ends)-1].Outcome)
			}
			if state.PendingInputID != "" || len(state.UnstartedInputs) != 0 || state.TurnActive {
				t.Fatalf("state = pending %q unstarted %v turnActive %v", state.PendingInputID, state.UnstartedInputs, state.TurnActive)
			}
		})
	}
}
