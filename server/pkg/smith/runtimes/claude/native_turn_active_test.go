package claude

import (
	"testing"

	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Ports the claude cases of tests/native-turn-active.test.ts and tests/tasks.test.ts.

func cClaudeInit(state projectionState) (projectionState, []oar.EventBody) {
	next, commands := fold(state, map[string]any{"type": "system", "subtype": "init"})
	var events []oar.EventBody
	for _, command := range commands {
		if command.Kind == "frame" {
			events = append(events, command.Body.Events...)
		}
	}
	return next, nonNilEvents(events)
}

func TestClaudeInitOnlyReportsSpontaneousRootStartsNeverASecondStart(t *testing.T) {
	started, events := cClaudeInit(initialClaudeProjection())
	assertJSON(t, events, `[{"kind":"turn_active"}]`)
	_, again := cClaudeInit(started)
	assertJSON(t, again, `[]`)
	_, commands := fold(initialClaudeProjection(), map[string]any{"type": "system", "subtype": "init", "parent_tool_use_id": "child"})
	assertJSON(t, frameEvents(commands), `[]`)
}

func TestClaudeHostPromptNeedsNoNativeStartAndOnlyARootResultPermitsAnotherTurn(t *testing.T) {
	prompted := claudePrompted(initialClaudeProjection(), "", true)
	_, events := cClaudeInit(prompted)
	assertJSON(t, events, `[]`)
	child, _ := fold(prompted, map[string]any{"type": "result", "parent_tool_use_id": "child", "subtype": "success"})
	_, events = cClaudeInit(child)
	assertJSON(t, events, `[]`)
	ended, _ := fold(prompted, map[string]any{"type": "result", "subtype": "success"})
	_, events = cClaudeInit(ended)
	assertJSON(t, events, `[{"kind":"turn_active"}]`)
}

func cClaudeNativeStart(t *testing.T) oar.FrameBody {
	t.Helper()
	_, commands := fold(initialClaudeProjection(), map[string]any{"type": "system", "subtype": "init"})
	if len(commands) == 0 || commands[0].Kind != "frame" {
		t.Fatal("native start must produce a frame")
	}
	return commands[0].Body
}

func cTurnMessages(records []oar.RawEvent) int {
	count := 0
	for _, message := range observe.ViewOf(records, "root").Messages {
		if message.Kind == "turn" {
			count++
		}
	}
	return count
}

func TestClaudeNativeActivityAdoptsATurnWithoutFabricatingAControlRequest(t *testing.T) {
	k := kernel.New("root", kernel.WithClock(func() int64 { return 0 }))
	frame := k.Frame(cClaudeNativeStart(t), kernel.RecordAt{})
	var kinds []string
	for _, event := range observe.EventsOf(frame, nil) {
		kinds = append(kinds, event.Kind())
	}
	assertJSON(t, kinds, `["turn_active"]`)
	assertJSON(t, observe.StatusOf(k.Records(), "root").Value, `{"kind":"running","lastEventAt":0,"phase":"waiting_model","sinceSeq":0}`)
	for _, record := range k.Records() {
		if record.Kind != oar.KindFrame {
			t.Fatalf("a %s record", record.Kind)
		}
	}
	if got := cTurnMessages(k.Records()); got != 1 {
		t.Fatalf("turns = %d", got)
	}
}

func TestClaudeNativeActivityPreservesAnExistingPromptPhaseAndTurnSegment(t *testing.T) {
	now := int64(0)
	k := kernel.New("root", kernel.WithClock(func() int64 { return now }))
	k.Request(oar.ToRuntime, oar.RequestBody{Kind: oar.RequestPrompt, Input: "go"}, kernel.RecordAt{ID: "prompt"})
	k.Frame(oar.FrameBody{Type: "tool", Native: []byte("{}"), Events: []oar.EventBody{oar.ToolCallStarted{CallID: "call", Tool: "shell"}}}, kernel.RecordAt{})
	now = 10
	k.Frame(cClaudeNativeStart(t), kernel.RecordAt{})
	assertJSON(t, observe.StatusOf(k.Records(), "root").Value, `{"kind":"running","lastEventAt":10,"phase":{"callId":"call","tool":"shell"},"requestId":"prompt","sinceSeq":0}`)
	if got := cTurnMessages(k.Records()); got != 1 {
		t.Fatalf("turns = %d", got)
	}
}

// The recorded claude stream (a background command and a background subagent) as records.
func TestClaudesBackgroundCommandAndSubagentReadAsTwoTasksWithTheirEnds(t *testing.T) {
	state := claudePrompted(initialClaudeProjection(), "", true)
	var records []oar.RawEvent
	for _, line := range readLines(t, replayFixtures+"/claude-background-tasks.raw.jsonl") {
		message, ok := parseNative([]byte(line))
		if !ok {
			message = nativeOf(map[string]any{})
		}
		var commands []projectionCommand
		state, commands = foldClaudeStdout(state, message)
		for _, command := range commands {
			if command.Kind != "frame" {
				continue
			}
			seq := int64(len(records))
			records = append(records, oar.RawEvent{Kind: oar.KindFrame, Envelope: oar.Envelope{SessionID: "s", AgentPath: command.AgentPath, Seq: seq, ReceivedAt: seq}, Frame: command.Body})
		}
	}
	cAssertMatches(t, observe.TasksOf(records, "s").Value, `[
		{"taskId":"bdc6lp8wy","taskType":"shell","nativeType":"local_bash","background":true,"status":"stopped","summary":"Sleep 8 seconds then print done"},
		{"taskId":"a8f6763441bcda20c","taskType":"agent","nativeType":"local_agent","background":true,"status":"completed","toolCallId":"toolu_017rmJ9ug4RCsCDqB31JdQVA"}]`)
}
