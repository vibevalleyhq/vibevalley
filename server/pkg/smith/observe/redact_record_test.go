package observe

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"vibevalley/pkg/smith/oar"
)

// Ported from tests/redact-record.test.ts.

func rrFrame(t *testing.T, frameType string, native any) oar.RawEvent {
	t.Helper()
	encoded, err := json.Marshal(native)
	if err != nil {
		t.Fatal(err)
	}
	return oar.RawEvent{Kind: oar.KindFrame, Envelope: oar.Envelope{SessionID: "s", AgentPath: []string{}, Seq: 3, ReceivedAt: 1},
		Frame: oar.FrameBody{Type: frameType, Native: encoded, Events: []oar.EventBody{}}}
}

func rrJSON(t *testing.T, record oar.RawEvent) string {
	t.Helper()
	encoded, err := json.Marshal(record)
	if err != nil {
		t.Fatal(err)
	}
	return string(encoded)
}

func rrValue(t *testing.T, record oar.RawEvent) any {
	t.Helper()
	var value any
	if err := json.Unmarshal([]byte(rrJSON(t, record)), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

// The shape oar recorded before 0.32.1 (grok 1.0.46 _x.ai/mcp/servers_updated).
func rrStored(t *testing.T) oar.RawEvent {
	return rrFrame(t, "_x.ai/mcp/servers_updated", map[string]any{
		"sessionId":  "s",
		"mcpServers": []any{map[string]any{"name": "userecho", "command": "node", "env": []any{map[string]any{"name": "OAR_ECHO_TOKEN", "value": "secret-from-config"}}}},
	})
}

func TestRedactRecordRedactsStoredGrokCredentials(t *testing.T) {
	stored := rrStored(t)
	before := rrJSON(t, stored)
	redacted, changed := RedactRecord(stored)
	if !changed {
		t.Fatal("a stored grok MCP notification must change")
	}
	want := rrFrame(t, "_x.ai/mcp/servers_updated", map[string]any{
		"sessionId":  "s",
		"mcpServers": []any{map[string]any{"name": "userecho", "command": "node", "env": []any{map[string]any{"name": "OAR_ECHO_TOKEN", "value": "[redacted]"}}}},
	})
	if !reflect.DeepEqual(rrValue(t, redacted), rrValue(t, want)) {
		t.Fatalf("redacted %s", rrJSON(t, redacted))
	}
	if strings.Contains(rrJSON(t, redacted), "secret-from-config") {
		t.Fatal("the credential survived")
	}
	if !strings.Contains(rrJSON(t, stored), "secret-from-config") || rrJSON(t, stored) != before {
		t.Fatal("the input record changed")
	}
}

func TestRedactRecordIdempotent(t *testing.T) {
	once, _ := RedactRecord(rrStored(t))
	if again, changed := RedactRecord(once); changed || rrJSON(t, again) != rrJSON(t, once) {
		t.Fatal("a redacted record must come back unchanged")
	}
	for _, record := range []oar.RawEvent{
		rrFrame(t, "session/update", map[string]any{"env": map[string]any{"TOKEN": "not a grok MCP notification"}}),
		rrFrame(t, "_x.ai/mcp/server_status", map[string]any{"name": "userecho", "status": "connected"}),
		{Kind: oar.KindRequest, ID: "r1", Direction: oar.ToRuntime, Envelope: oar.Envelope{SessionID: "s", AgentPath: []string{}, Seq: 1, ReceivedAt: 1}, Request: oar.RequestBody{Kind: oar.RequestDispose}},
	} {
		got, changed := RedactRecord(record)
		if changed || !reflect.DeepEqual(got, record) {
			t.Fatalf("untouched record changed: %s", rrJSON(t, got))
		}
	}
}

func TestRedactionRulesNameEveryCoveredFrameType(t *testing.T) {
	if RedactionRules.Version < 1 {
		t.Fatalf("version %d", RedactionRules.Version)
	}
	secret := map[string]any{"mcpServers": []any{map[string]any{"name": "x", "env": map[string]any{"TOKEN": "secret-value"}}}}
	for _, prefix := range RedactionRules.FrameTypePrefixes {
		frameType := prefix
		if strings.HasSuffix(prefix, "/") {
			frameType += "servers_updated"
		}
		redacted, _ := RedactRecord(rrFrame(t, frameType, secret))
		if strings.Contains(rrJSON(t, redacted), "secret-value") {
			t.Fatalf("%s kept the secret", frameType)
		}
	}
	for _, frameType := range []string{"_x.ai/other", "session/update", "x_x.ai/mcp/servers_updated", "thread/tokenUsage/updated"} {
		other := rrFrame(t, frameType, secret)
		if got, changed := RedactRecord(other); changed || !reflect.DeepEqual(got, other) {
			t.Fatalf("%s changed", frameType)
		}
	}
}

func TestRedactRecordKeepsNumbersVerbatim(t *testing.T) {
	record := rrFrame(t, "_x.ai/mcp/servers_updated", map[string]any{"count": json.Number("12345678901234567890"), "env": map[string]any{"K": "v"}})
	redacted, changed := RedactRecord(record)
	if !changed || !strings.Contains(string(redacted.Frame.Native), "12345678901234567890") {
		t.Fatalf("native %s", redacted.Frame.Native)
	}
}
