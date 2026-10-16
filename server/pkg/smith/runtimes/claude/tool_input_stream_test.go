//go:build wip_b

package claude

import (
	"bytes"
	"encoding/json"
	"path/filepath"
	"reflect"
	"testing"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Ports tests/claude/claude-tool-input-stream.test.ts. Claude 2.1.292,
// recorded against a mock provider and the local MCP echo fixture.

func b_project(t *testing.T, previous projectionState, message nativeMessage) (projectionState, projectionCommand) {
	t.Helper()
	state, commands := foldClaudeStdout(previous, message)
	if len(commands) != 1 || commands[0].Kind != "frame" {
		t.Fatalf("commands = %+v", commands)
	}
	command := commands[0]
	if !bytes.Equal(command.Body.Native, message.raw) {
		t.Fatal("the frame's native is not the line")
	}
	native := jsonx.AsRecord(message.Record["event"])
	block := jsonx.AsRecord(native["content_block"])
	delta := jsonx.AsRecord(native["delta"])
	if native["type"] == "content_block_start" && block["type"] == "tool_use" {
		assertJSON(t, command.Body.Events, jsonText([]any{map[string]any{"kind": "tool_call_started", "callId": block["id"], "tool": block["name"]}}))
	}
	if delta["type"] == "input_json_delta" {
		if len(command.Body.Events) != 1 {
			t.Fatalf("events = %v", command.Body.Events)
		}
		event, ok := command.Body.Events[0].(oar.ToolCallInputDelta)
		if !ok || event.Delta != delta["partial_json"] {
			t.Fatalf("event = %+v", command.Body.Events[0])
		}
	}
	return state, command
}

// b_toolPart is the view's tool part for callID, as JSON.
func b_toolPart(view observe.SessionView, callID string) map[string]any {
	var parsed struct {
		Messages []struct {
			Kind     string `json:"kind"`
			Sections []struct {
				Parts []map[string]any `json:"parts"`
			} `json:"sections"`
		} `json:"messages"`
	}
	_ = json.Unmarshal([]byte(jsonText(view)), &parsed)
	for _, message := range parsed.Messages {
		if message.Kind != "turn" {
			continue
		}
		for _, section := range message.Sections {
			for _, part := range section.Parts {
				if part["kind"] == "tool" && part["callId"] == callID {
					return part
				}
			}
		}
	}
	return nil
}

func TestRecordedMcpArgumentsStreamOnceBeforeCompleteInput(t *testing.T) {
	k := kernel.New("fixture")
	state := initialClaudeProjection()
	view := observe.InitialSessionView()
	deltas := 0
	started := map[string]bool{}
	streamed := map[string]string{}
	for _, line := range readLines(t, filepath.Join(replayFixtures, "claude-tool-input-stream.raw.jsonl")) {
		message, ok := parseNative([]byte(line))
		if !ok {
			continue
		}
		var command projectionCommand
		state, command = b_project(t, state, message)
		for _, event := range command.Body.Events {
			switch typed := event.(type) {
			case oar.ToolCallStarted:
				if started[typed.CallID] {
					t.Fatalf("%s started twice", typed.CallID)
				}
				started[typed.CallID] = true
				if len(command.AgentPath) > 0 && (typed.Input == nil || len(*typed.Input) <= 20000) {
					t.Fatal("the unstreamed child call lacks its full input")
				}
			case oar.ToolCallInputDelta:
				deltas++
				streamed[typed.CallID] += typed.Delta
			case oar.ToolCallInput:
				var fromStream, complete any
				if json.Unmarshal([]byte(streamed[typed.CallID]), &fromStream) != nil || json.Unmarshal([]byte(typed.Input), &complete) != nil || !reflect.DeepEqual(fromStream, complete) {
					t.Fatalf("streamed input differs for %s", typed.CallID)
				}
				var input string
				for _, block := range contentBlocks(message) {
					if block.Record["id"] == typed.CallID {
						input = string(block.rawOf("input"))
					}
				}
				if typed.Input != input {
					t.Fatal("tool_call_input is not JSON.stringify of the block's input")
				}
			}
		}
		record := k.Frame(command.Body, kernel.RecordAt{AgentPath: command.AgentPath})
		view = observe.ReduceSessionView(view, record, k.SessionID())
		for _, event := range command.Body.Events {
			switch typed := event.(type) {
			case oar.ToolCallInputDelta:
				part := b_toolPart(view, typed.CallID)
				if part == nil || part["input"] != streamed[typed.CallID] || part["inputPartial"] != true {
					t.Fatalf("part = %v", part)
				}
			case oar.ToolCallInput:
				part := b_toolPart(view, typed.CallID)
				if part == nil || part["input"] != typed.Input {
					t.Fatalf("part = %v", part)
				}
				if _, partial := part["inputPartial"]; partial {
					t.Fatal("a complete input is still partial")
				}
			default:
				continue
			}
			break
		}
	}
	if len(started) != 3 || deltas != 318 || len(state.Partials) != 0 {
		t.Fatalf("started %d deltas %d partials %d", len(started), deltas, len(state.Partials))
	}
	if jsonText(view) != jsonText(observe.ViewOf(k.Records(), k.SessionID())) {
		t.Fatal("the live view differs from the replayed one")
	}
}

func b_streamReader() func(message map[string]any) []projectionCommand {
	state := initialClaudeProjection()
	return func(message map[string]any) []projectionCommand {
		var commands []projectionCommand
		state, commands = fold(state, message)
		var frames []projectionCommand
		for _, command := range commands {
			if command.Kind == "frame" {
				frames = append(frames, command)
			}
		}
		return frames
	}
}

func b_stream(event map[string]any, parent any) map[string]any {
	return map[string]any{"type": "stream_event", "event": event, "parent_tool_use_id": parent}
}

func b_start(index int, id string, parent any) map[string]any {
	return b_stream(map[string]any{"type": "content_block_start", "index": index, "content_block": map[string]any{"type": "tool_use", "id": id, "name": "echo", "input": map[string]any{}}}, parent)
}

func b_delta(index int, partial string, parent any) map[string]any {
	return b_stream(map[string]any{"type": "content_block_delta", "index": index, "delta": map[string]any{"type": "input_json_delta", "partial_json": partial}}, parent)
}

func TestBlockIndexesAndCallIDsIsolateParallelCalls(t *testing.T) {
	read := b_streamReader()
	read(b_stream(map[string]any{"type": "message_start", "message": map[string]any{"id": "root-message"}}, nil))
	read(b_start(0, "parent", nil))
	read(b_start(1, "root-other", nil))
	read(b_start(0, "nested", "parent"))
	assertJSON(t, read(b_delta(0, "root", nil))[0].Body.Events, `[{"kind":"tool_call_input_delta","callId":"parent","delta":"root"}]`)
	assertJSON(t, read(b_delta(1, "other", nil))[0].Body.Events, `[{"kind":"tool_call_input_delta","callId":"root-other","delta":"other"}]`)
	child := read(b_delta(0, "child", "parent"))[0]
	if !reflect.DeepEqual(child.AgentPath, []string{"parent"}) {
		t.Fatalf("path = %v", child.AgentPath)
	}
	assertJSON(t, child.Body.Events, `[{"kind":"tool_call_input_delta","callId":"nested","delta":"child"}]`)
	if path := read(b_start(0, "grandchild", "nested"))[0].AgentPath; !reflect.DeepEqual(path, []string{"parent", "nested"}) {
		t.Fatalf("path = %v", path)
	}
	assertJSON(t, nonNilEvents(read(b_delta(9, "unmatched", nil))[0].Body.Events), `[]`)
	assertJSON(t, read(b_delta(1, "", nil))[0].Body.Events, `[{"kind":"tool_call_input_delta","callId":"root-other","delta":""}]`)
}
