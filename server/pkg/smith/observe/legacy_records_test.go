package observe_test

import (
	"encoding/json"
	"testing"

	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

// Port of tests/legacy-records.test.ts: a tool end as OAR before 0.14.0
// recorded it, the result as one `output` string. In Go the upgrade happens
// when the record is decoded (oar.DecodeEventBody), the place a stored
// record enters the folds.

func legacyEnd(t *testing.T, seq int, output string) oar.RawEvent {
	t.Helper()
	data, err := json.Marshal(map[string]any{
		"kind": "frame", "seq": seq, "sessionId": "s", "agentPath": []string{}, "receivedAt": 0,
		"body": map[string]any{"type": "user", "native": map[string]any{}, "events": []any{
			map[string]any{"kind": "tool_call_ended", "callId": "c1", "output": output, "result": "ok"},
		}},
	})
	if err != nil {
		t.Fatal(err)
	}
	var record oar.RawEvent
	if err := json.Unmarshal(data, &record); err != nil {
		t.Fatal(err)
	}
	return record
}

func TestLegacyOutputReadsAsContent(t *testing.T) {
	blocks, _ := json.Marshal([]any{
		map[string]any{"type": "text", "text": "shot"},
		map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": "image/png", "data": "iVBOR"}},
	})
	svEq(t, "blocks", oar.ContentOfLegacyOutput(string(blocks)), `[{"type":"text","text":"shot"},{"type":"image","mediaType":"image/png","data":"iVBOR"}]`)
	quoted, _ := json.Marshal("nope")
	svEq(t, "quoted", oar.ContentOfLegacyOutput(string(quoted)), `[{"type":"text","text":"nope"}]`)
	svEq(t, "plain", oar.ContentOfLegacyOutput("✔ add\n"), `[{"type":"text","text":"✔ add\n"}]`)
	svEq(t, "object", oar.ContentOfLegacyOutput(`{"exit_code":0}`), `[{"type":"text","text":"{\"exit_code\":0}"}]`)
}

func TestLegacyRecordsReplayThroughEventsAndTheView(t *testing.T) {
	record := legacyEnd(t, 3, "contents")
	events := observe.EventsOf(record, nil)
	svMatch(t, "events", events, `[{"kind":"tool_call_ended","callId":"c1","content":[{"type":"text","text":"contents"}],"result":"ok"}]`)
	if svHas(events[0], "output") {
		t.Error("the event still has output")
	}
	lane := svLane{Session: "s"}
	records := []oar.RawEvent{
		svRequestIn(lane, 0, "r1", oar.ToRuntime, oar.RequestBody{Kind: oar.RequestPrompt, Input: "go"}),
		svResponseIn(lane, 1, "r1", oar.Accepted()),
		svFrameIn(lane, 2, oar.ToolCallStarted{CallID: "c1", Tool: "Read", Input: oar.String("f")}),
		record,
	}
	parts := []observe.ViewPart{}
	for _, turn := range svTurns(observe.ViewOf(records, "")) {
		parts = append(parts, svTurnParts(turn)...)
	}
	svMatch(t, "parts", parts, `[{"kind":"tool","callId":"c1","content":[{"type":"text","text":"contents"}],"result":"ok"}]`)
}
