package observe_test

import (
	"encoding/json"
	"fmt"
	"testing"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Ports of tests/tool-call-input.test.ts and tests/tool-call-input-delta.test.ts.

func tciRecords() []oar.RawEvent {
	frame := func(seq, at int64, events ...oar.EventBody) oar.RawEvent {
		record := svFrameIn(svLane{Session: "s1", At: at}, seq, events...)
		record.Frame.Type = "tool_call_update"
		return record
	}
	return []oar.RawEvent{
		svRequestIn(svLane{Session: "s1"}, 0, "r1", oar.ToRuntime, oar.RequestBody{Kind: oar.RequestPrompt, Input: "go"}),
		frame(1, 10, oar.ToolCallStarted{CallID: "c1", Tool: "bash", Input: oar.String(`{"cwd":"/tmp/x"}`)}),
		frame(2, 20, oar.ToolCallInput{CallID: "c1", Input: `{"command":"ls","cwd":"/tmp/x"}`}),
		frame(3, 30, oar.ToolCallInput{CallID: "c1", Input: `{"command":"ls -a","cwd":"/tmp/x"}`}),
		frame(4, 40, oar.ToolCallInput{CallID: "c9", Input: `{"filePath":"a.txt"}`}),
	}
}

func TestToolCallInputLatestInputWinsAndAnUnstartedInputRenders(t *testing.T) {
	view := observe.ViewOf(tciRecords(), "")
	turns := svTurns(view)
	if len(turns) == 0 {
		t.Fatal("no turn")
	}
	svEq(t, "parts", svTurnParts(turns[0]), `[
		{"kind":"tool","callId":"c1","tool":"bash","input":"{\"command\":\"ls -a\",\"cwd\":\"/tmp/x\"}","result":"running","startedAt":10},
		{"kind":"tool","callId":"c9","tool":"?","input":"{\"filePath\":\"a.txt\"}","result":"running"}]`)
}

func TestToolCallInputKeepsTheToolPhaseAndMovesTheClock(t *testing.T) {
	status := observe.InitialStatus
	for _, record := range tciRecords()[:3] {
		status = observe.ReduceStatus(status, record, "")
	}
	svEq(t, "status", status, `{"kind":"running","sinceSeq":0,"requestId":"r1","phase":{"tool":"bash","callId":"c1"},"lastEventAt":20}`)
}

// ─── tool_call_input_delta ────────────────────────────────────────────────

// tciFixture is a stream with a live view folded record by record.
type tciFixture struct {
	stream *svStream
	live   observe.SessionView
}

func newTCIFixture() *tciFixture {
	return &tciFixture{stream: svNewStream("root"), live: observe.InitialSessionView()}
}

func (f *tciFixture) push(event oar.EventBody, scope svLane) oar.RawEvent {
	record := f.stream.frame(scope, event)
	native, _ := json.Marshal(event)
	f.stream.records[len(f.stream.records)-1].Frame.Native = native
	record.Frame.Native = native
	f.live = observe.ReduceSessionView(f.live, record, "")
	return record
}

func TestToolCallInputDeltaAppendsVerbatimThenCompleteInputReplaces(t *testing.T) {
	f := newTCIFixture()
	f.push(oar.ToolCallStarted{CallID: "call", Tool: "show_widget"}, svLane{})
	pieces := []string{`{"widget_code":"`, `<svg title=\"你好`, `\">`, `\n`, `</svg>"}`}
	accumulated := ""
	for _, delta := range pieces {
		last := f.push(oar.ToolCallInputDelta{CallID: "call", Delta: delta}, svLane{})
		accumulated += delta
		want, _ := json.Marshal(map[string]any{"input": accumulated, "inputPartial": true, "result": "running"})
		svMatch(t, "partial", svTools(f.live)[0], string(want))
		svSame(t, "live vs replay", f.live, observe.ViewOf(f.stream.records, ""))
		svSame(t, "repeated record", svTools(observe.ReduceSessionView(f.live, last, "")), svTools(f.live))
		svMatch(t, "status", observe.StatusOf(f.stream.records, "").Value,
			fmt.Sprintf(`{"kind":"running","phase":{"tool":"show_widget","callId":"call"},"lastEventAt":%d}`, last.ReceivedAt))
	}
	// A complete snapshot is authoritative even when it differs from the fragments.
	f.push(oar.ToolCallInput{CallID: "call", Input: `{"widget_code":"final"}`}, svLane{})
	svMatch(t, "complete", svTools(f.live)[0], `{"input":"{\"widget_code\":\"final\"}","result":"running"}`)
	if _, has := svTools(f.live)[0]["inputPartial"]; has {
		t.Error("inputPartial kept after the complete input")
	}
	f.push(oar.ToolCallEnded{CallID: "call", Result: "ok"}, svLane{})
	if n := len(svTools(f.live)); n != 1 {
		t.Errorf("tools = %d", n)
	}
	svMatch(t, "ended", svTools(f.live)[0], `{"input":"{\"widget_code\":\"final\"}","result":"ok"}`)
	svSame(t, "live vs replay", f.live, observe.ViewOf(f.stream.records, ""))
}

func TestToolCallInputDeltaWithoutAStartRendersUnknownInput(t *testing.T) {
	f := newTCIFixture()
	f.push(oar.ToolCallInputDelta{CallID: "call", Delta: ""}, svLane{})
	svEq(t, "parts", svTools(f.live), `[{"sessionId":"root","agentPath":[],"kind":"tool","callId":"call","tool":"?","input":"","inputPartial":true,"result":"running"}]`)
	f.push(oar.ToolCallInputDelta{CallID: "call", Delta: "not valid JSON"}, svLane{})
	if input := svTools(f.live)[0]["input"]; input != "not valid JSON" {
		t.Errorf("input = %v", input)
	}
	f.push(oar.ToolCallInput{CallID: "call", Input: ""}, svLane{})
	if input := svTools(f.live)[0]["input"]; input != "" {
		t.Errorf("input = %v", input)
	}
	if _, has := svTools(f.live)[0]["inputPartial"]; has {
		t.Error("inputPartial kept")
	}
}

func TestToolCallInputDeltaKeepsLanesAndNeverReopensAnEndedCall(t *testing.T) {
	f := newTCIFixture()
	lanes := []svLane{{}, {Path: []string{"child"}}, {Session: "other"}}
	for _, scope := range lanes {
		f.push(oar.ToolCallStarted{CallID: "same", Tool: "echo"}, scope)
	}
	for index, scope := range lanes {
		f.push(oar.ToolCallInputDelta{CallID: "same", Delta: fmt.Sprint(index)}, scope)
	}
	f.push(oar.TurnEnded{Outcome: oar.AbortedOutcome()}, svLane{})
	f.push(oar.ToolCallInputDelta{CallID: "same", Delta: "+late"}, svLane{})
	rows := [][]any{}
	for _, part := range svTools(f.live) {
		rows = append(rows, []any{part["sessionId"], part["agentPath"], part["input"], part["inputPartial"], part["result"]})
	}
	svEq(t, "rows", rows, `[["root",[],"0+late",true,"ended"],["root",["child"],"1",true,"running"],["other",[],"2",true,"running"]]`)
	f.push(oar.ToolCallInput{CallID: "same", Input: "complete"}, svLane{})
	svMatch(t, "complete", svTools(f.live)[0], `{"input":"complete","result":"ended"}`)
	if _, has := svTools(f.live)[0]["inputPartial"]; has {
		t.Error("inputPartial kept")
	}
	svSame(t, "live vs replay", f.live, observe.ViewOf(f.stream.records, ""))
}

func TestToolCallInputDeltaPhaseSaysWritingWhileArgumentsStream(t *testing.T) {
	f := newTCIFixture()
	phase := func() any {
		status := observe.StatusOf(f.stream.records, "").Value
		if status.IsRunning() {
			return status.Phase
		}
		return status.Kind
	}
	f.push(oar.ToolCallStarted{CallID: "call", Tool: "show_widget"}, svLane{})
	svEq(t, "started", phase(), `{"tool":"show_widget","callId":"call"}`)
	f.push(oar.ToolCallInputDelta{CallID: "call", Delta: `{"widget_code":"`}, svLane{})
	svEq(t, "writing", phase(), `{"tool":"show_widget","callId":"call","writing":true}`)
	// Another call's arguments never change the current phase.
	f.push(oar.ToolCallInput{CallID: "other", Input: "{}"}, svLane{})
	svEq(t, "other call", phase(), `{"tool":"show_widget","callId":"call","writing":true}`)
	f.push(oar.ToolCallInput{CallID: "call", Input: `{"widget_code":"x"}`}, svLane{})
	svEq(t, "complete", phase(), `{"tool":"show_widget","callId":"call"}`)
}
