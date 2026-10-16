package opencode

// Ported from tests/opencode/child-attribution.test.ts and
// tests/opencode/mcp-replay.test.ts: recorded OpenCode 2 notifications
// (tests/replay/fixtures/opencode-acp-v2-*.json) through the ACP recorder
// with v2's child attribution.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"vibevalley/pkg/smith/internal/acp"
	"vibevalley/pkg/smith/internal/jsonx"
	"vibevalley/pkg/smith/kernel"
	"vibevalley/pkg/smith/oar"
	"vibevalley/pkg/smith/observe"
)

const replayFixtures = "../../testdata/replay/fixtures"

// replayNotifications is a fixture's `notifications`, each verbatim.
func replayNotifications(t *testing.T, name string) []json.RawMessage {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(replayFixtures, name))
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Notifications []json.RawMessage `json:"notifications"`
	}
	if err := json.Unmarshal(data, &fixture); err != nil || fixture.Notifications == nil {
		t.Fatalf("%s: %v", name, err)
	}
	return fixture.Notifications
}

func roundTrip(t *testing.T, records []oar.RawEvent) []oar.RawEvent {
	t.Helper()
	encoded, err := json.Marshal(records)
	if err != nil {
		t.Fatal(err)
	}
	var restored []oar.RawEvent
	if err := json.Unmarshal(encoded, &restored); err != nil {
		t.Fatal(err)
	}
	return restored
}

func boundRecorder(gate *acp.UsageGate) (*kernel.Kernel, *acp.Recorder) {
	k := kernel.New("root")
	recorder := acp.NewRecorder(gate, ChildAttribution, nil)
	recorder.Bind(k)
	return k, recorder
}

func TestRecordedV2ChildShellAndTextKeepTheirOwnSessionAndVerbatimParentEnvelope(t *testing.T) {
	notifications := replayNotifications(t, "opencode-acp-v2-child.json")
	k, recorder := boundRecorder(acp.NewUsageGate())
	for _, notification := range notifications {
		recorder.Update(notification)
	}
	persisted := roundTrip(t, k.Records())
	jsonEqual(t, observe.GraphOf(persisted), k.Graph())
	jsonEqual(t, observe.ViewOf(persisted, "").Usage, observe.UsageOf(persisted, "root", nil).Value)
	jsonEqual(t, k.Graph(), `{"edges": [{"child": "child-1", "parent": "root", "via": "tool_call"}], "nodes": [{"id": "root"}, {"id": "child-1"}]}`)
	type childFrame struct {
		SessionID string          `json:"sessionId"`
		Events    []oar.EventBody `json:"events"`
	}
	children := []childFrame{}
	for _, record := range k.Records() {
		if record.Kind == oar.KindFrame && record.SessionID != "root" {
			children = append(children, childFrame{record.SessionID, record.Frame.Events})
		}
	}
	jsonEqual(t, children, `[
		{"events": [
			{"callId": "child-1:call-2", "input": "{\"cwd\":\"/project\"}", "kind": "tool_call_started", "tool": "shell"},
			{"child": "child-1", "kind": "session_linked", "parent": "root", "via": "tool_call"}], "sessionId": "child-1"},
		{"events": [{"callId": "child-1:call-2", "input": "{\"command\":\"echo CHILD-OK-7731\",\"cwd\":\"/project\"}", "kind": "tool_call_input"}], "sessionId": "child-1"},
		{"events": [], "sessionId": "child-1"},
		{"events": [{"callId": "child-1:call-2", "content": [{"text": "CHILD-OK-7731\n", "type": "text"}], "kind": "tool_call_ended", "result": "ok"}], "sessionId": "child-1"},
		{"events": [{"kind": "text_delta", "text": "CHILD-OK-7731"}], "sessionId": "child-1"}]`)
	for index, record := range k.Records() {
		if record.Kind != oar.KindFrame {
			t.Fatalf("record %d is %s", index, record.Kind)
		}
		jsonEqual(t, record.Frame.Native, notifications[index], "record ", index)
	}
	// Both live subscription and replay use the same frame envelopes; child text is never root text.
	rootText := []oar.EventBody{}
	for _, record := range k.Records() {
		if record.Kind == oar.KindFrame && record.SessionID == "root" {
			for _, event := range record.Frame.Events {
				if event.EventKind() == "text_delta" {
					rootText = append(rootText, event)
				}
			}
		}
	}
	jsonEqual(t, rootText, `[{"kind": "text_delta", "text": "CHILD-OK-7731"}]`)
}

func childUpdate(child map[string]any, update map[string]any) map[string]any {
	withMeta := map[string]any{"_meta": map[string]any{"opencode/child-session": child}}
	for key, value := range update {
		withMeta[key] = value
	}
	return map[string]any{"sessionId": "root", "update": withMeta}
}

func encoded(t *testing.T, value any) json.RawMessage {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func links(records []oar.RawEvent) []oar.EventBody {
	out := []oar.EventBody{}
	for _, record := range records {
		if record.Kind == oar.KindFrame {
			for _, event := range record.Frame.Events {
				if event.EventKind() == "session_linked" {
					out = append(out, event)
				}
			}
		}
	}
	return out
}

func TestOnlyTheFirstNativeReportOfEachEdgeEmitsLineage(t *testing.T) {
	k := kernel.New("root")
	recorder := acp.NewRecorder(acp.NewUsageGate(), ChildAttribution, nil)
	var mu sync.Mutex
	var live []oar.RawEvent
	k.RawEvents(func(record oar.RawEvent) {
		mu.Lock()
		live = append(live, record)
		mu.Unlock()
	}, nil)
	recorder.Step("session/new", encoded(t, map[string]any{"sessionId": "root"}))
	message := map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "hello"}}
	notification := encoded(t, childUpdate(map[string]any{"id": "child", "parentID": "root"}, message))
	recorder.Update(notification)
	recorder.Update(notification)
	recorder.Bind(k)
	recorder.Extension("_x.ai/session_notification", encoded(t, map[string]any{"sessionId": "root", "childSessionId": "child", "parentSessionId": "root"}), true)
	recorder.Update(encoded(t, childUpdate(map[string]any{"id": "child", "parentID": "another-parent"}, message)))
	jsonEqual(t, links(k.Records()), `[
		{"kind": "session_linked", "parent": "root", "child": "child", "via": "tool_call"},
		{"kind": "session_linked", "parent": "another-parent", "child": "child", "via": "tool_call"}]`)
	var replayed []oar.RawEvent
	k.RawEvents(func(record oar.RawEvent) { replayed = append(replayed, record) }, &oar.Cursor{SessionID: "root", AfterSeq: -1})()
	if !eventually(func() bool { mu.Lock(); defer mu.Unlock(); return len(live) == len(k.Records()) }, 5e9) {
		t.Fatal("live delivery incomplete")
	}
	mu.Lock()
	jsonEqual(t, replayed, live)
	mu.Unlock()
	jsonEqual(t, observe.GraphOf(replayed), k.Graph())
	resumed, resumedRecorder := boundRecorder(acp.NewUsageGate())
	resumedRecorder.Update(notification)
	resumedRecorder.Update(notification)
	jsonEqual(t, links(resumed.Records()), `[{"kind": "session_linked", "parent": "root", "child": "child", "via": "tool_call"}]`)
}

func TestNestedDescendantsLinkTheirReportedParentAndNeverSatisfyRootUsageWaiting(t *testing.T) {
	gate := acp.NewUsageGate()
	gate.Arm()
	k, recorder := boundRecorder(gate)
	recorder.Update(encoded(t, childUpdate(map[string]any{"id": "grandchild", "parentID": "child", "depth": 2}, map[string]any{"sessionUpdate": "usage_update", "used": 77, "size": 100})))
	// TS spies on gate.observe; an observed root usage update would leave nothing to wait for.
	if gate.Settle(acp.Profile{UsageUpdateAfterPrompt: true, UsageUpdateTimeout: 1}, false) == nil {
		t.Fatal("a descendant's usage satisfied the root's wait")
	}
	jsonEqual(t, k.Graph(), `{"edges": [{"child": "grandchild", "parent": "child", "via": "tool_call"}], "nodes": [{"id": "root"}, {"id": "grandchild"}, {"id": "child"}]}`)
	type entry struct {
		SessionID string        `json:"sessionId"`
		Body      oar.FrameBody `json:"body"`
	}
	var got []entry
	for _, record := range k.Records() {
		got = append(got, entry{record.SessionID, record.Frame})
	}
	jsonEqual(t, got, `[{"body": {
		"events": [
			{"kind": "usage", "usage": {"context": {"contextWindow": 100, "percent": 77, "tokens": 77}}},
			{"child": "grandchild", "kind": "session_linked", "parent": "child", "via": "tool_call"}],
		"native": {"sessionId": "root", "update": {"_meta": {"opencode/child-session": {"depth": 2, "id": "grandchild", "parentID": "child"}}, "sessionUpdate": "usage_update", "size": 100, "used": 77}},
		"type": "usage_update"}, "sessionId": "grandchild"}]`)
}

func TestIncompleteLineageIsNotFabricated(t *testing.T) {
	for _, meta := range []map[string]any{{}, {"id": "child"}, {"id": "", "parentID": "root"}, {"id": "root", "parentID": "root"}} {
		notification := childUpdate(meta, map[string]any{"sessionUpdate": "agent_message_chunk", "content": map[string]any{"type": "text", "text": "native"}})
		if got := ChildAttribution(jsonx.ParseRecord(encoded(t, notification))); got != nil {
			t.Fatalf("%v: %+v", meta, got)
		}
	}
}

func TestTheEnvelopeMetadataSpellingWorksEvenWhenUpdateMetadataHasOtherFields(t *testing.T) {
	got := ChildAttribution(jsonx.ParseRecord([]byte(`{"sessionId": "root", "_meta": {"opencode/child-session": {"id": "child", "parentID": "root"}}, "update": {"sessionUpdate": "future", "_meta": {"extra": true}}}`)))
	if got == nil || got.SessionID != "child" || got.Parent != "root" {
		t.Fatalf("%+v", got)
	}
}

func TestToolClassificationRetainsV1BashAndRecognizesV2Shell(t *testing.T) {
	input := `{"command":"echo CHILD-OK-7731","code":"return 1"}`
	type classified struct {
		Tool   string             `json:"tool"`
		Action observe.ToolAction `json:"action"`
	}
	var got []classified
	for _, tool := range []string{"bash", "shell", "subagent", "execute"} {
		got = append(got, classified{tool, observe.ClassifyTool("opencode", tool, &input)})
	}
	jsonEqual(t, got, `[
		{"action": {"command": "echo CHILD-OK-7731", "detail": "echo CHILD-OK-7731", "kind": "run_command"}, "tool": "bash"},
		{"action": {"command": "echo CHILD-OK-7731", "detail": "echo CHILD-OK-7731", "kind": "run_command"}, "tool": "shell"},
		{"action": {"detail": "echo CHILD-OK-7731", "kind": "subagent"}, "tool": "subagent"},
		{"action": {"detail": "echo CHILD-OK-7731", "kind": "other"}, "tool": "execute"}]`)
}

func TestNativeV2McpThroughExecuteRetainsCodeToolResultAndMetadata(t *testing.T) {
	notifications := replayNotifications(t, "opencode-acp-v2-mcp.json")
	k, recorder := boundRecorder(acp.NewUsageGate())
	for _, notification := range notifications {
		recorder.Update(notification)
	}
	events := []oar.EventBody{}
	for _, record := range k.Records() {
		if record.Kind == oar.KindFrame {
			events = append(events, record.Frame.Events...)
		}
	}
	jsonEqual(t, events, `[
		{"callId": "execute-echo", "input": "{}", "kind": "tool_call_started", "tool": "execute"},
		{"callId": "execute-echo", "input": "{\"code\":\" await tools.echo.echo({ text: \\\"MCP_NEW_271\\\" })\"}", "kind": "tool_call_input"},
		{"callId": "execute-echo", "content": [{"text": "echo:MCP_NEW_271 via=stdio token=none", "type": "text"}], "kind": "tool_call_ended", "result": "ok"}]`)
	var input *string
	for index, record := range k.Records() {
		if record.Kind != oar.KindFrame || record.SessionID != "root" {
			t.Fatalf("record %d: %s %s", index, record.Kind, record.SessionID)
		}
		jsonEqual(t, record.Frame.Native, notifications[index], "record ", index)
		raw := jsonx.RawFields(jsonx.RawFields(notifications[index])["update"])["rawInput"]
		if input == nil && raw != nil && jsonx.ParseRecord(raw)["code"] != nil {
			text := jsonx.Stringify(raw)
			input = &text
		}
	}
	jsonEqual(t, observe.ClassifyTool("opencode", "execute", input), `{"detail": "execute", "kind": "other"}`)
	jsonEqual(t, k.Graph(), `{"edges": [], "nodes": [{"id": "root"}]}`)
}
