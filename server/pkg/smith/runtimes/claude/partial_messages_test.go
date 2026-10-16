//go:build wip_a

package claude

import (
	"reflect"
	"sort"
	"testing"

	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Ports tests/claude/claude-partial-messages.test.ts.

func partialReader(t *testing.T) func(message map[string]any) []oar.EventBody {
	state := initialClaudeProjection()
	return func(message map[string]any) []oar.EventBody {
		t.Helper()
		var commands []projectionCommand
		state, commands = fold(state, message)
		var frames []projectionCommand
		for _, command := range commands {
			if command.Kind == "frame" {
				frames = append(frames, command)
			}
		}
		if len(frames) != 1 {
			t.Fatalf("frames = %d", len(frames))
		}
		if !reflect.DeepEqual(jsonx.ParseRecord(frames[0].Body.Native), jsonx.ParseRecord([]byte(jsonText(message)))) {
			t.Fatalf("native %s is not the message", frames[0].Body.Native)
		}
		return nonNilEvents(frames[0].Body.Events)
	}
}

func partialEvent(event map[string]any, parent any) map[string]any {
	return map[string]any{"type": "stream_event", "event": event, "parent_tool_use_id": parent}
}

func partialStart(id string, parent any) map[string]any {
	return partialEvent(map[string]any{"type": "message_start", "message": map[string]any{"id": id}}, parent)
}

func partialBlockStart(index int, kind string, parent any) map[string]any {
	return partialEvent(map[string]any{"type": "content_block_start", "index": index, "content_block": map[string]any{"type": kind}}, parent)
}

func partialDelta(index int, kind, value string, parent any) map[string]any {
	return partialEvent(map[string]any{"type": "content_block_delta", "index": index, "delta": map[string]any{"type": kind + "_delta", kind: value}}, parent)
}

func finalMessage(id string, content []any, parent any) map[string]any {
	return map[string]any{"type": "assistant", "message": map[string]any{"id": id, "content": content}, "parent_tool_use_id": parent}
}

func textBlock(text string) map[string]any { return map[string]any{"type": "text", "text": text} }

func TestNativeDeltasArriveBeforeTheFinalBlockWithoutRepeating(t *testing.T) {
	read := partialReader(t)
	assertJSON(t, read(partialStart("m1", nil)), `[]`)
	read(partialBlockStart(0, "thinking", nil))
	assertJSON(t, read(partialDelta(0, "thinking", "Let me think.", nil)), `[{"kind":"reasoning","content":{"kind":"text","text":"Let me think."},"messageId":"m1"}]`)
	assertJSON(t, read(finalMessage("m1", []any{map[string]any{"type": "thinking", "thinking": "Let me think."}}, nil)), `[]`)
	assertJSON(t, read(partialEvent(map[string]any{"type": "content_block_stop", "index": 0}, nil)), `[]`)
	read(partialBlockStart(1, "text", nil))
	assertJSON(t, read(partialDelta(1, "text", "Alpha", nil)), `[{"kind":"text_delta","text":"Alpha","messageId":"m1"}]`)
	assertJSON(t, read(partialDelta(1, "text", " beta", nil)), `[{"kind":"text_delta","text":" beta","messageId":"m1"}]`)
	assertJSON(t, read(finalMessage("m1", []any{textBlock("Alpha beta")}, nil)), `[]`)
	// Claude repeats the same API id for separate completed blocks.
	read(partialBlockStart(2, "text", nil))
	read(partialDelta(2, "text", "Alpha beta", nil))
	assertJSON(t, read(finalMessage("m1", []any{textBlock("Alpha beta")}, nil)), `[]`)
}

func TestUnidentifiedToolJSONAndSignaturesStayRaw(t *testing.T) {
	read := partialReader(t)
	read(partialStart("m2", nil))
	read(partialBlockStart(0, "tool_use", nil))
	assertJSON(t, read(partialEvent(map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "input_json_delta", "partial_json": `{"command":`}}, nil)), `[]`)
	assertJSON(t, read(partialEvent(map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "signature_delta", "signature": "opaque"}}, nil)), `[]`)
	assertJSON(t, read(finalMessage("m2", []any{map[string]any{"type": "tool_use", "id": "call-1", "name": "Bash", "input": map[string]any{"command": "true"}}}, nil)),
		`[{"kind":"tool_call_started","callId":"call-1","tool":"Bash","input":"{\"command\":\"true\"}"}]`)
}

func TestRootAndChildMessagesKeepIndependentPartialState(t *testing.T) {
	read := partialReader(t)
	read(partialStart("root", nil))
	read(partialBlockStart(0, "text", nil))
	read(partialStart("child", "task-1"))
	read(partialBlockStart(0, "text", "task-1"))
	assertJSON(t, read(partialDelta(0, "text", "root", nil)), `[{"kind":"text_delta","text":"root","messageId":"root"}]`)
	assertJSON(t, read(partialDelta(0, "text", "child", "task-1")), `[{"kind":"text_delta","text":"child","messageId":"child"}]`)
	read(map[string]any{"type": "result"})
	assertJSON(t, read(finalMessage("child", []any{textBlock("child")}, "task-1")), `[]`)
	assertJSON(t, read(finalMessage("root", []any{textBlock("root")}, nil)), `[]`)
	read(partialStart("next", nil))
	read(partialBlockStart(0, "text", nil))
	assertJSON(t, read(partialDelta(0, "text", "root", nil)), `[{"kind":"text_delta","text":"root","messageId":"next"}]`)
}

func TestUnstreamedContentRedactionAndEmptyThinkingSurvive(t *testing.T) {
	read := partialReader(t)
	assertJSON(t, read(finalMessage("plain", []any{textBlock("normal"), map[string]any{"type": "thinking", "thinking": ""}, map[string]any{"type": "redacted_thinking", "data": "opaque"}}, nil)), `[
		{"kind":"text_delta","text":"normal","messageId":"plain"},
		{"kind":"reasoning","content":{"kind":"empty"},"messageId":"plain"},
		{"kind":"reasoning","content":{"kind":"redacted"},"messageId":"plain"}]`)
	read(partialStart("partial", nil))
	read(partialBlockStart(0, "text", nil))
	read(partialDelta(0, "text", "first", nil))
	assertJSON(t, read(finalMessage("partial", []any{textBlock("first last")}, nil)), `[{"kind":"text_delta","text":" last","messageId":"partial"}]`)
}

func TestCoalescedReasoningRespectsTheMessageIdentityBoundary(t *testing.T) {
	var events []oar.Event
	observer := observe.CoalesceText(func(event oar.Event) { events = append(events, event) }, 0)
	for seq, entry := range [][2]string{{"m1", "Think"}, {"m1", " more"}, {"m2", "Next"}} {
		observer(oar.Event{Envelope: oar.Envelope{SessionID: "s", AgentPath: []string{}, Seq: int64(seq), ReceivedAt: int64(seq)},
			Body: oar.Reasoning{Content: oar.ReasoningContent{Kind: "text", Text: entry[1]}, MessageID: entry[0]}})
	}
	observer(oar.Event{Envelope: oar.Envelope{SessionID: "s", AgentPath: []string{}, Seq: 3, ReceivedAt: 3}, Body: oar.TurnEnded{Outcome: oar.Completed()}})
	var got [][2]any
	for _, event := range events {
		if reasoning, ok := event.Body.(oar.Reasoning); ok {
			got = append(got, [2]any{reasoning.MessageID, reasoning.Content})
		}
	}
	assertJSON(t, got, `[["m1",{"kind":"text","text":"Think more"}],["m2",{"kind":"text","text":"Next"}]]`)
}

func TestMessageStopReleasesOnlyItsAgentsPartialState(t *testing.T) {
	state := initialClaudeProjection()
	for _, message := range []map[string]any{partialStart("root", nil), partialBlockStart(0, "text", nil), partialDelta(0, "text", "root", nil), partialStart("child", "task-1"), partialBlockStart(0, "text", "task-1"), partialDelta(0, "text", "child", "task-1")} {
		state, _ = fold(state, message)
	}
	if len(state.Partials) != 2 {
		t.Fatalf("partials = %d", len(state.Partials))
	}
	state, _ = fold(state, finalMessage("root", []any{textBlock("root")}, nil))
	boundary := partialEvent(map[string]any{"type": "message_stop"}, nil)
	stopped, commands := fold(state, boundary)
	keys := []string{}
	for key := range stopped.Partials {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	if !reflect.DeepEqual(keys, []string{`["task-1"]`}) {
		t.Fatalf("partials = %v", keys)
	}
	if len(commands) != 1 || commands[0].Kind != "frame" || len(commands[0].AgentPath) != 0 || commands[0].Body.Type != "stream_event" || len(commands[0].Body.Events) != 0 {
		t.Fatalf("commands = %+v", commands)
	}
	assertJSON(t, jsonx.ParseRecord(commands[0].Body.Native), jsonText(boundary))
	child, commands := fold(stopped, finalMessage("child", []any{textBlock("child")}, "task-1"))
	assertJSON(t, commandEvents(commands), `[]`)
	done, _ := fold(child, partialEvent(map[string]any{"type": "message_stop"}, "task-1"))
	if len(done.Partials) != 0 {
		t.Fatalf("partials = %d", len(done.Partials))
	}
	state = done
	nextEvents := []oar.EventBody{}
	for _, message := range []map[string]any{partialStart("next", nil), partialBlockStart(0, "text", nil), partialDelta(0, "text", "root", nil), finalMessage("next", []any{textBlock("root")}, nil), boundary} {
		var folded []projectionCommand
		state, folded = fold(state, message)
		nextEvents = append(nextEvents, commandEvents(folded)...)
	}
	assertJSON(t, nextEvents, `[{"kind":"text_delta","text":"root","messageId":"next"}]`)
	if len(state.Partials) != 0 {
		t.Fatalf("partials = %d", len(state.Partials))
	}
}
