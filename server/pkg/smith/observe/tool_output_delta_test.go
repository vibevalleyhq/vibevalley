package observe_test

import (
	"testing"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Port of tests/tool-output-delta.test.ts. The first TS test drives the
// codex and pi projections, which Go does not have; it is ported on the
// events those projections produce (codex: tool_call_started for the
// commandExecution item, then one tool_call_progress outputDelta per
// item/commandExecution/outputDelta; pi: tool_execution_update as a
// tool_call_progress output snapshot of its partialResult JSON).

func TestToolOutputDeltaChunksAccumulateThenASnapshotReplaces(t *testing.T) {
	f := newTCIFixture()
	f.push(oar.ToolCallStarted{CallID: "call", Tool: "commandExecution", Input: oar.String("printf chunks")}, svLane{})
	f.push(oar.ToolCallProgress{CallID: "call", OutputDelta: oar.String("first\n")}, svLane{})
	f.push(oar.ToolCallProgress{CallID: "call", OutputDelta: oar.String("second\n")}, svLane{})
	if output := svTools(f.live)[0]["output"]; output != "first\nsecond\n" {
		t.Errorf("output = %q", output)
	}
	progress := []oar.EventBody{}
	for _, record := range f.stream.records {
		for _, event := range record.Frame.Events {
			if _, ok := event.(oar.ToolCallProgress); ok {
				progress = append(progress, event)
			}
		}
	}
	svEq(t, "progress events", progress, `[{"callId":"call","kind":"tool_call_progress","outputDelta":"first\n"},{"callId":"call","kind":"tool_call_progress","outputDelta":"second\n"}]`)
	f.push(oar.ToolCallProgress{CallID: "call", Output: oar.String(`{"content":[{"type":"text","text":"retained window"}],"details":{}}`)}, svLane{})
	if output := svTools(f.live)[0]["output"]; output != `{"content":[{"type":"text","text":"retained window"}],"details":{}}` {
		t.Errorf("output = %q", output)
	}
	svSame(t, "live vs replay", f.live, observe.ViewOf(f.stream.records, ""))
	// Replaying the cursor's last record twice must not append its output twice.
	last := f.stream.records[len(f.stream.records)-1]
	svSame(t, "repeated", svTools(observe.ReduceSessionView(f.live, last, "")), svTools(f.live))
}

func TestToolOutputDeltaPreviewsReplaceClearAndEnd(t *testing.T) {
	s := &svStream{root: "root"}
	push := func(event oar.EventBody) {
		s.frame(svLane{}, event)
		s.records[len(s.records)-1].Frame.Type = "progress"
		s.records[len(s.records)-1].ReceivedAt = 0
	}
	output := func() any { return svTools(observe.ViewOf(s.records, ""))[0]["output"] }
	push(oar.ToolCallProgress{CallID: "call", OutputDelta: oar.String("first")})
	previews := []any{output()}
	for _, event := range []oar.ToolCallProgress{
		{CallID: "call", OutputDelta: oar.String("+second")},
		{CallID: "call", Output: oar.String("")},
		{CallID: "call", OutputDelta: oar.String("fresh")},
		{CallID: "call"},
		{CallID: "call", Output: oar.String("snapshot"), OutputDelta: oar.String("+tail")},
	} {
		push(event)
		previews = append(previews, output())
	}
	svEq(t, "previews", previews, `["first","first+second","","fresh","fresh","snapshot+tail"]`)
	push(oar.ToolCallEnded{CallID: "call", Result: "ok", Content: []oar.ToolOutputPart{{Type: "text", Text: "final"}}})
	svEq(t, "ended", svTools(observe.ViewOf(s.records, "")), `[{"agentPath":[],"callId":"call","content":[{"text":"final","type":"text"}],"endedAt":0,"kind":"tool","result":"ok","sessionId":"root","tool":"?"}]`)
}

func TestToolOutputDeltaLateDeltasKeepTheirEndedToolAndLane(t *testing.T) {
	s := svNewStream("root")
	push := func(event oar.EventBody, session string) oar.RawEvent {
		return s.frame(svLane{Session: session}, event)
	}
	push(oar.ToolCallStarted{CallID: "same", Tool: "shell"}, "root")
	push(oar.ToolCallProgress{CallID: "same", OutputDelta: oar.String("root-1")}, "root")
	push(oar.ToolCallStarted{CallID: "same", Tool: "shell"}, "child")
	push(oar.ToolCallProgress{CallID: "same", OutputDelta: oar.String("child-1")}, "child")
	push(oar.TurnEnded{Outcome: oar.AbortedOutcome()}, "root")
	push(oar.ToolCallProgress{CallID: "same", OutputDelta: oar.String("+root-2")}, "root")
	last := push(oar.ToolCallProgress{CallID: "same", OutputDelta: oar.String("+child-2")}, "child")
	view := observe.ViewOf(s.records, "")
	rows := []map[string]any{}
	for _, part := range svTools(view) {
		rows = append(rows, svPick(part, "sessionId", "result", "output"))
	}
	svEq(t, "rows", rows, `[{"output":"root-1+root-2","result":"ended","sessionId":"root"},{"output":"child-1+child-2","result":"running","sessionId":"child"}]`)
	svSame(t, "repeated", svTools(observe.ReduceSessionView(view, last, "")), svTools(view))
}
